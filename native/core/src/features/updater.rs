//! Actualizaciones: el estado que ve la UI (`feat:updater:status`) y cómo cambia en cada paso, el canal, «Más tarde» y
//! los textos de error. Equivale a src/main/features/updater-core.ts y a las transiciones de updater.ts; la búsqueda y
//! la descarga (el updater firmado de Tauri) y el reloj entran desde afuera.
use super::updater_notas::GrupoNotas;
use serde::Serialize;
use serde_json::{json, Value};

pub const CADA_MS: u64 = 6 * 60 * 60 * 1000;
pub const PRIMER_CHEQUEO_MS: u64 = 20_000;
/// Con la ventana oculta o con batería, el chequeo automático se reintenta en 5 minutos.
pub const REINTENTO_MS: u64 = 5 * 60 * 1000;

pub const SIN_DESCARGAR: &str = "Todavía no hay una actualización descargada.";
pub const BUSCA_PRIMERO: &str = "Primero buscá una actualización.";
pub const EN_DESARROLLO_CHEQUEO: &str = "En desarrollo no se buscan actualizaciones: solo en la app instalada.";
pub const EN_DESARROLLO_DESCARGA: &str = "En desarrollo no hay actualizaciones que descargar.";
pub const SIN_CONEXION: &str = "No hay conexión con GitHub.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Canal {
    Estable,
    Beta,
}

/// Canal elegido en Configuración: solo `"beta"` exacto es beta.
pub fn canal_de_ajustes(ajustes: &Value) -> Canal {
    if ajustes.get("updateChannel").and_then(Value::as_str) == Some("beta") {
        Canal::Beta
    } else {
        Canal::Estable
    }
}

pub fn proximo_chequeo_ms(modo_liviano: bool) -> u64 {
    if modo_liviano {
        CADA_MS * 2
    } else {
        CADA_MS
    }
}

/// «Más tarde»: la versión pospuesta y el día local (AAAA-MM-DD). Es `updater-later.json`, `{ version, day }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pospuesta {
    pub version: String,
    pub dia: String,
}

impl Pospuesta {
    pub fn desde_json(v: &Value) -> Option<Pospuesta> {
        Some(Pospuesta { version: v.get("version")?.as_str()?.to_string(), dia: v.get("day")?.as_str()?.to_string() })
    }

    pub fn a_json(&self) -> Value {
        json!({ "version": self.version, "day": self.dia })
    }
}

/// Esa versión quedó para después hoy: otra versión, o el día siguiente, vuelve a avisar.
pub fn pospuesta_el(p: Option<&Pospuesta>, version: &str, dia: &str) -> bool {
    p.is_some_and(|p| p.version == version && p.dia == dia)
}

/// El error del updater como se le muestra a la persona. Cubre los de electron-updater y los del updater de Tauri.
pub fn amigable(msg: &str) -> String {
    let m = msg.to_lowercase();
    let alguno = |claves: &[&str]| claves.iter().any(|c| m.contains(c));
    if alguno(&["enotfound", "econnrefused", "etimedout", "err_internet_disconnected", "net::", "error sending request", "dns error", "connection refused", "timed out", "tcp connect"]) {
        return SIN_CONEXION.into();
    }
    if alguno(&["404", "no published versions", "cannot find latest", "could not fetch a valid release json"]) {
        return "Todavía no hay versiones publicadas.".into();
    }
    if alguno(&["sha512 checksum mismatch", "signature", "minisign"]) {
        return "La descarga llegó dañada; se reintenta en el próximo chequeo.".into();
    }
    let primera: String = msg.split('\n').next().unwrap_or("").to_string();
    let corta = super::cortar_utf16(&primera, 200);
    if corta.is_empty() {
        "Error desconocido.".into()
    } else {
        corta
    }
}

/// Lo que trajo una búsqueda: la versión nueva, la fecha (ISO) y las notas en markdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encontrada {
    pub version: String,
    pub fecha: Option<String>,
    pub notas: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estado {
    pub state: Fase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<GrupoNotas>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transferred: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_to_date: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub later: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued: Option<bool>,
    pub channel: Canal,
    pub enabled: bool,
    pub current: String,
}

impl Estado {
    pub fn nuevo(actual: &str, habilitado: bool, canal: Canal) -> Estado {
        Estado {
            state: Fase::Idle,
            version: None,
            release_date: None,
            notes: None,
            percent: None,
            transferred: None,
            total: None,
            error: None,
            checked_at: None,
            up_to_date: None,
            later: None,
            queued: None,
            channel: canal,
            enabled: habilitado,
            current: actual.into(),
        }
    }

    fn fase(&mut self, f: Fase) {
        self.state = f;
        // El progreso solo existe mientras se descarga.
        if f != Fase::Downloading {
            self.percent = None;
            self.transferred = None;
            self.total = None;
        }
    }

    /// Ya hay una búsqueda o una descarga en curso, o una versión lista: no se vuelve a buscar.
    pub fn ocupado(&self) -> bool {
        matches!(self.state, Fase::Checking | Fase::Downloading | Fase::Ready)
    }

    pub fn al_buscar(&mut self, canal: Canal) {
        self.channel = canal;
        self.fase(Fase::Checking);
        self.error = None;
    }

    pub fn al_encontrar(&mut self, e: &Encontrada, pospuesta_hoy: bool) {
        let misma = self.version.as_deref() == Some(e.version.as_str());
        self.fase(Fase::Available);
        self.queued = Some(misma && self.queued == Some(true));
        self.version = Some(e.version.clone());
        self.up_to_date = Some(false);
        self.later = Some(pospuesta_hoy);
        self.release_date = e.fecha.clone();
        self.error = None;
        if !misma {
            self.notes = None;
        }
    }

    /// Las notas llegan después (pueden pedirse a GitHub): si mientras tanto apareció otra versión, no sirven.
    pub fn con_notas(&mut self, version: &str, notas: Vec<GrupoNotas>, fecha: Option<String>) -> bool {
        if self.version.as_deref() != Some(version) {
            return false;
        }
        self.notes = Some(notas);
        if fecha.is_some() {
            self.release_date = fecha;
        }
        true
    }

    pub fn al_no_haber(&mut self, ahora: u64) {
        if self.state == Fase::Ready {
            return;
        }
        self.fase(Fase::Idle);
        self.checked_at = Some(ahora);
        self.up_to_date = Some(true);
        self.version = None;
        self.notes = None;
        self.later = Some(false);
        self.queued = Some(false);
    }

    /// Error de la búsqueda o de la descarga. Si ya hay una versión descargada (o disponible tras cancelar), se mantiene:
    /// el error fue de otro paso.
    pub fn al_fallar(&mut self, msg: &str, ahora: u64) -> bool {
        if matches!(self.state, Fase::Ready | Fase::Available) {
            return false;
        }
        self.fase(Fase::Error);
        self.error = Some(amigable(msg));
        self.checked_at = Some(ahora);
        true
    }

    /// Error que no viene del updater (sin conexión, en desarrollo): el texto va tal cual.
    pub fn con_error(&mut self, texto: &str) {
        self.fase(Fase::Error);
        self.error = Some(texto.into());
    }

    pub fn al_bajar(&mut self) {
        self.fase(Fase::Downloading);
        self.percent = Some(0);
        self.error = None;
    }

    /// Devuelve si cambió algo que la UI tenga que ver (el porcentaje entero, no cada trozo).
    pub fn al_avanzar(&mut self, transferido: u64, total: Option<u64>) -> bool {
        let porcentaje = match total {
            Some(t) if t > 0 => ((transferido as f64 / t as f64) * 100.0).round().clamp(0.0, 100.0) as u32,
            _ => 0,
        };
        if self.state == Fase::Downloading && self.percent == Some(porcentaje) {
            return false;
        }
        self.fase(Fase::Downloading);
        self.percent = Some(porcentaje);
        self.transferred = Some(transferido);
        self.total = total;
        true
    }

    pub fn al_bajada(&mut self, ahora: u64) {
        self.fase(Fase::Ready);
        self.checked_at = Some(ahora);
        self.error = None;
    }

    pub fn al_cancelar(&mut self) -> bool {
        if self.state != Fase::Downloading {
            return false;
        }
        self.fase(Fase::Available);
        self.queued = Some(false);
        true
    }

    /// «Más tarde»: lo que hay que guardar para no volver a avisar hoy, si había algo que posponer.
    pub fn al_posponer(&mut self, dia: &str) -> Option<Pospuesta> {
        let version = self.version.clone().filter(|_| matches!(self.state, Fase::Available | Fase::Ready | Fase::Downloading))?;
        self.later = Some(true);
        Some(Pospuesta { version, dia: dia.into() })
    }

    pub fn al_encolar(&mut self) {
        self.queued = Some(true);
        self.later = Some(false);
    }

    pub fn a_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Canal beta: el `latest.json` del release más nuevo, aunque sea prerelease (la API de GitHub los lista del más nuevo
/// al más viejo). El estable usa el endpoint de tauri.conf.json, que es `releases/latest` y nunca da un prerelease.
pub fn latest_json_beta(releases: &Value) -> Option<String> {
    releases.as_array()?.iter().filter(|r| r.get("draft") != Some(&Value::Bool(true))).find_map(|r| {
        r.get("assets")?
            .as_array()?
            .iter()
            .find(|a| a.get("name").and_then(Value::as_str) == Some("latest.json"))?
            .get("browser_download_url")?
            .as_str()
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
            .map(str::to_string)
    })
}

/// Cuerpo y fecha de un release de la API de GitHub (`/releases/tags/<tag>`), para cuando el update no trae notas.
pub fn cuerpo_del_release(release: &Value) -> (Option<String>, Option<String>) {
    let t = |k: &str| release.get(k).and_then(Value::as_str).map(str::to_string);
    (t("body"), t("published_at"))
}

/// Los tags que se prueban para una versión, en orden.
pub fn tags_de(version: &str) -> [String; 2] {
    [format!("v{version}"), version.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::templates::hoy;

    fn encontrada(v: &str) -> Encontrada {
        Encontrada { version: v.into(), fecha: Some("2026-05-01T10:00:00Z".into()), notas: String::new() }
    }

    fn estado() -> Estado {
        Estado::nuevo("0.8.0", true, Canal::Estable)
    }

    #[test]
    fn amigable_traduce_los_errores_de_red() {
        for m in ["getaddrinfo ENOTFOUND github.com", "connect ECONNREFUSED", "net::ERR_FAILED", "ETIMEDOUT", "error sending request for url (https://github.com/x)", "dns error: no such host"] {
            assert_eq!(amigable(m), SIN_CONEXION, "{m}");
        }
    }

    #[test]
    fn amigable_traduce_404_y_descarga_danada() {
        assert_eq!(amigable("HttpError: 404 Not Found"), "Todavía no hay versiones publicadas.");
        assert_eq!(amigable("Cannot find latest.yml"), "Todavía no hay versiones publicadas.");
        assert_eq!(amigable("Could not fetch a valid release JSON from the remote"), "Todavía no hay versiones publicadas.");
        assert!(amigable("sha512 checksum mismatch, expected x").contains("dañada"));
        assert!(amigable("Invalid encoding in minisign data").contains("dañada"));
    }

    #[test]
    fn amigable_corta_a_la_primera_linea_y_a_200_caracteres() {
        assert_eq!(amigable("uno\ndos"), "uno");
        assert_eq!(amigable(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn amigable_tolera_textos_vacios() {
        assert_eq!(amigable(""), "Error desconocido.");
        assert_eq!(amigable("\nsegunda"), "Error desconocido.");
        assert_eq!(amigable("texto suelto"), "texto suelto");
    }

    #[test]
    fn el_canal_solo_es_beta_con_el_valor_exacto() {
        assert_eq!(canal_de_ajustes(&json!({ "updateChannel": "beta" })), Canal::Beta);
        for v in [json!({ "updateChannel": "Beta" }), json!({ "updateChannel": 1 }), json!({}), Value::Null, json!("beta"), json!([])] {
            assert_eq!(canal_de_ajustes(&v), Canal::Estable, "{v}");
        }
    }

    #[test]
    fn la_pospuesta_exige_version_y_day_como_texto() {
        let p = Pospuesta::desde_json(&json!({ "version": "1.2.3", "day": "2026-01-02", "extra": 1 }));
        assert_eq!(p, Some(Pospuesta { version: "1.2.3".into(), dia: "2026-01-02".into() }));
        for v in [Value::Null, json!(3), json!("x"), json!({}), json!({ "version": "1" }), json!({ "version": 1, "day": "a" })] {
            assert_eq!(Pospuesta::desde_json(&v), None, "{v}");
        }
        assert_eq!(p.unwrap().a_json().to_string(), r#"{"version":"1.2.3","day":"2026-01-02"}"#);
    }

    #[test]
    fn pospone_solo_la_misma_version_el_mismo_dia() {
        let p = Pospuesta { version: "1.0.0".into(), dia: "2026-05-01".into() };
        assert!(pospuesta_el(Some(&p), "1.0.0", "2026-05-01"));
        assert!(!pospuesta_el(Some(&p), "1.0.1", "2026-05-01"));
        assert!(!pospuesta_el(Some(&p), "1.0.0", "2026-05-02"));
        assert!(!pospuesta_el(None, "1.0.0", "2026-05-01"));
    }

    #[test]
    fn el_dia_local_rellena_mes_y_dia_con_ceros() {
        // 2026-01-05 23:59 y 2026-12-31 00:00 en UTC-3.
        assert_eq!(hoy(1_767_668_340_000.0, -180), "2026-01-05");
        assert_eq!(hoy(1_798_686_000_000.0, -180), "2026-12-31");
    }

    #[test]
    fn el_intervalo_se_duplica_en_modo_liviano() {
        assert_eq!(proximo_chequeo_ms(false), CADA_MS);
        assert_eq!(proximo_chequeo_ms(true), CADA_MS * 2);
    }

    #[test]
    fn el_estado_inicial_se_serializa_como_lo_espera_la_ui() {
        assert_eq!(estado().a_json(), json!({ "state": "idle", "channel": "estable", "enabled": true, "current": "0.8.0" }));
    }

    #[test]
    fn buscar_y_encontrar_deja_la_version_disponible() {
        let mut s = estado();
        s.al_buscar(Canal::Beta);
        assert_eq!((s.state, s.channel, s.ocupado()), (Fase::Checking, Canal::Beta, true));
        s.al_encontrar(&encontrada("0.9.0"), false);
        assert_eq!(
            s.a_json(),
            json!({ "state": "available", "version": "0.9.0", "releaseDate": "2026-05-01T10:00:00Z", "upToDate": false, "later": false, "queued": false, "channel": "beta", "enabled": true, "current": "0.8.0" })
        );
    }

    #[test]
    fn la_misma_version_conserva_al_cerrar_y_otra_lo_apaga() {
        let mut s = estado();
        s.al_encontrar(&encontrada("0.9.0"), false);
        s.al_encolar();
        s.al_encontrar(&encontrada("0.9.0"), true);
        assert_eq!((s.queued, s.later), (Some(true), Some(true)));
        s.al_encontrar(&encontrada("0.9.1"), false);
        assert_eq!(s.queued, Some(false));
    }

    #[test]
    fn las_notas_de_otra_version_se_descartan() {
        let mut s = estado();
        s.al_encontrar(&encontrada("0.9.0"), false);
        assert!(!s.con_notas("0.8.9", vec![], None));
        assert!(s.con_notas("0.9.0", vec![GrupoNotas { id: "nuevo".into(), label: "Nuevo".into(), items: vec!["a".into()] }], Some("2026-06-01".into())));
        assert_eq!(s.a_json()["notes"], json!([{ "id": "nuevo", "label": "Nuevo", "items": ["a"] }]));
        assert_eq!(s.release_date.as_deref(), Some("2026-06-01"));
    }

    #[test]
    fn sin_novedades_queda_al_dia_salvo_que_ya_haya_una_lista() {
        let mut s = estado();
        s.al_encontrar(&encontrada("0.9.0"), false);
        s.al_no_haber(5);
        assert_eq!(s.a_json(), json!({ "state": "idle", "checkedAt": 5, "upToDate": true, "later": false, "queued": false, "channel": "estable", "enabled": true, "current": "0.8.0", "releaseDate": "2026-05-01T10:00:00Z" }));
        let mut lista = estado();
        lista.al_encontrar(&encontrada("0.9.0"), false);
        lista.al_bajada(9);
        lista.al_no_haber(10);
        assert_eq!(lista.state, Fase::Ready);
    }

    #[test]
    fn la_descarga_avanza_por_porcentaje_entero_y_el_progreso_desaparece_al_terminar() {
        let mut s = estado();
        s.al_encontrar(&encontrada("0.9.0"), false);
        s.al_bajar();
        assert_eq!((s.state, s.percent), (Fase::Downloading, Some(0)));
        assert!(s.al_avanzar(500, Some(1000)));
        assert!(!s.al_avanzar(502, Some(1000)));
        assert!(s.al_avanzar(2000, Some(1000)));
        assert_eq!((s.percent, s.transferred, s.total), (Some(100), Some(2000), Some(1000)));
        s.al_bajada(7);
        assert_eq!((s.state, s.percent, s.transferred, s.total, s.checked_at), (Fase::Ready, None, None, None, Some(7)));
    }

    #[test]
    fn sin_total_el_porcentaje_queda_en_cero() {
        let mut s = estado();
        s.al_bajar();
        assert!(!s.al_avanzar(10, None));
        assert_eq!((s.state, s.percent), (Fase::Downloading, Some(0)));
    }

    #[test]
    fn un_error_no_pisa_una_version_lista_ni_disponible() {
        let mut s = estado();
        s.al_buscar(Canal::Estable);
        assert!(s.al_fallar("connect ECONNREFUSED", 3));
        assert_eq!((s.state, s.error.as_deref(), s.checked_at), (Fase::Error, Some(SIN_CONEXION), Some(3)));
        s.al_encontrar(&encontrada("0.9.0"), false);
        assert!(!s.al_fallar("otra cosa", 4));
        assert_eq!(s.state, Fase::Available);
        s.al_bajar();
        assert!(s.al_fallar("signature mismatch", 5));
        assert_eq!(s.percent, None);
    }

    #[test]
    fn cancelar_solo_corta_una_descarga_en_curso() {
        let mut s = estado();
        assert!(!s.al_cancelar());
        s.al_encontrar(&encontrada("0.9.0"), false);
        s.al_encolar();
        s.al_bajar();
        s.al_avanzar(1, Some(2));
        assert!(s.al_cancelar());
        assert_eq!((s.state, s.queued, s.percent), (Fase::Available, Some(false), None));
    }

    #[test]
    fn mas_tarde_solo_pospone_si_hay_una_version() {
        let mut s = estado();
        assert_eq!(s.al_posponer("2026-05-01"), None);
        assert_eq!(s.later, None);
        s.al_encontrar(&encontrada("0.9.0"), false);
        assert_eq!(s.al_posponer("2026-05-01"), Some(Pospuesta { version: "0.9.0".into(), dia: "2026-05-01".into() }));
        assert_eq!(s.later, Some(true));
        s.al_encolar();
        assert_eq!((s.queued, s.later), (Some(true), Some(false)));
    }

    #[test]
    fn el_canal_beta_toma_el_latest_json_del_release_mas_nuevo_que_no_sea_borrador() {
        let r = json!([
            { "draft": true, "prerelease": true, "assets": [{ "name": "latest.json", "browser_download_url": "https://x/borrador/latest.json" }] },
            { "draft": false, "prerelease": true, "assets": [{ "name": "Sloth-Setup.exe", "browser_download_url": "https://x/a.exe" }] },
            { "draft": false, "prerelease": true, "assets": [{ "name": "latest.json", "browser_download_url": "https://x/beta/latest.json" }] },
            { "draft": false, "prerelease": false, "assets": [{ "name": "latest.json", "browser_download_url": "https://x/estable/latest.json" }] }
        ]);
        assert_eq!(latest_json_beta(&r).as_deref(), Some("https://x/beta/latest.json"));
        assert_eq!(latest_json_beta(&json!([{ "assets": [{ "name": "latest.json", "browser_download_url": "file:///c/latest.json" }] }])), None);
        assert_eq!(latest_json_beta(&json!({ "message": "rate limit" })), None);
        assert_eq!(latest_json_beta(&json!([])), None);
    }

    #[test]
    fn el_cuerpo_del_release_sale_de_body_y_published_at() {
        assert_eq!(cuerpo_del_release(&json!({ "body": "## Nuevo\n- a", "published_at": "2026-05-01T00:00:00Z" })), (Some("## Nuevo\n- a".into()), Some("2026-05-01T00:00:00Z".into())));
        assert_eq!(cuerpo_del_release(&json!({ "body": null })), (None, None));
        assert_eq!(tags_de("0.9.0"), ["v0.9.0".to_string(), "0.9.0".to_string()]);
    }
}
