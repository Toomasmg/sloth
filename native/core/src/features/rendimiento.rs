//! Equivale a src/shared/rendimiento-core.ts: de los perfiles de la Configuración a los límites del Job Object de
//! las terminales. El Job y PowerShell quedan del lado del SO; acá solo van las decisiones y el formato de lo que se intercambia.
use crate::perfiles_core::es_blanco_js;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfilRendimiento {
    pub ram_mb: u64,
    pub nucleos: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendimientoSettings {
    pub enchufada: PerfilRendimiento,
    pub bateria: PerfilRendimiento,
    pub bateria_distinta: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limites {
    /// 0 = sin límite.
    #[serde(rename = "ramMB")]
    pub ram_mb: u64,
    /// Núcleos que quedan habilitados (siempre al menos 1).
    pub nucleos: u64,
    /// Máscara de afinidad en decimal: los primeros `nucleos` procesadores lógicos.
    pub afinidad: String,
}

/// Windows asigna afinidad por grupos de 64 procesadores: más allá no se puede elegir desde un Job.
const MAX_AFINIDAD: u64 = 64;

pub fn perfil_vigente(r: &RendimientoSettings, en_bateria: bool) -> PerfilRendimiento {
    if en_bateria && r.bateria_distinta {
        r.bateria
    } else {
        r.enchufada
    }
}

/// Un tope igual o mayor a lo que hay es «sin límite»; los núcleos vuelven siempre como máscara completa, porque al
/// sacar el límite del Job Windows no devuelve sola la afinidad que ya les aplicó a los procesos.
pub fn limites_de(perfil: PerfilRendimiento, ram_total_mb: u64, nucleos_totales: u64) -> Limites {
    let total = nucleos_totales.clamp(1, MAX_AFINIDAD);
    let nucleos = if perfil.nucleos > 0 { perfil.nucleos.min(total) } else { total };
    let ram_mb = if perfil.ram_mb > 0 && perfil.ram_mb < ram_total_mb { perfil.ram_mb } else { 0 };
    let afinidad = ((1u128 << nucleos) - 1).to_string();
    Limites { ram_mb, nucleos, afinidad }
}

pub fn sin_limites(l: &Limites, nucleos_totales: u64) -> bool {
    l.ram_mb == 0 && l.nucleos >= nucleos_totales.min(MAX_AFINIDAD)
}

/// Nombre del Job Object: uno por proceso dueño (el daemon, o Sloth sin daemon).
pub fn nombre_job(dueno_pid: u64) -> String {
    format!("Local\\Sloth-Rendimiento-{dueno_pid}")
}

#[derive(Debug, Clone)]
pub struct PedidoJob {
    pub nombre: String,
    /// Proceso desde el que se recorre el árbol. `f64` porque llega de un número de JS y se valida acá.
    pub raiz: f64,
    /// El daemon entra al Job con sus terminales; Sloth (sin daemon) no, solo sus terminales.
    pub incluir_raiz: bool,
    /// Ejecutable que nunca entra (Electron, en modo sin daemon). Vacío = ninguno.
    pub excluir: String,
    pub limites: Limites,
    /// Proceso que se queda con un handle del Job: mientras viva, el nombre sigue y los límites se pueden cambiar.
    pub dueno: f64,
}

fn pid_valido(n: f64) -> bool {
    n.fract() == 0.0 && n.is_finite() && n > 0.0
}

/// Variables de entorno para el script: solo números validados y una ruta, nada se interpola en el código.
pub fn entorno_job(p: &PedidoJob) -> Result<BTreeMap<String, String>, String> {
    for n in [p.raiz, p.dueno] {
        if !pid_valido(n) {
            return Err(format!("PID inválido: {n}"));
        }
    }
    let mut e = BTreeMap::new();
    e.insert("SLOTH_JOB_NOMBRE".to_string(), p.nombre.clone());
    e.insert("SLOTH_JOB_RAIZ".to_string(), p.raiz.to_string());
    e.insert("SLOTH_JOB_INCLUIR_RAIZ".to_string(), if p.incluir_raiz { "1" } else { "0" }.to_string());
    e.insert("SLOTH_JOB_EXCLUIR".to_string(), p.excluir.clone());
    e.insert("SLOTH_JOB_RAM_BYTES".to_string(), (p.limites.ram_mb * 1024 * 1024).to_string());
    e.insert("SLOTH_JOB_AFINIDAD".to_string(), p.limites.afinidad.clone());
    e.insert("SLOTH_JOB_DUENO".to_string(), p.dueno.to_string());
    Ok(e)
}

#[derive(Debug, Clone, PartialEq)]
pub struct SalidaJob {
    pub procesos: f64,
    pub vistos: f64,
}

/// Lee la línea JSON que imprime el script (la última, tras recortar).
pub fn leer_salida_job(stdout: &str) -> Result<SalidaJob, String> {
    let inesperada = || "Salida inesperada del script de rendimiento.".to_string();
    let recortado = stdout.trim_matches(es_blanco_js);
    let linea = recortado.rsplit('\n').next().unwrap_or("").trim_end_matches('\r');
    let v: Value = serde_json::from_str(linea).map_err(|e| e.to_string())?;
    let o = v.as_object().ok_or_else(inesperada)?;
    match (o.get("procesos").and_then(Value::as_f64), o.get("vistos").and_then(Value::as_f64)) {
        (Some(procesos), Some(vistos)) => Ok(SalidaJob { procesos, vistos }),
        _ => Err(inesperada()),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aplicado {
    #[serde(flatten)]
    pub limites: Limites,
    pub procesos: f64,
    pub en: f64,
}

/// Lo que ve la sección «Rendimiento» de la Configuración.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoRendimiento {
    /// Solo Windows tiene Job Objects.
    pub soportado: bool,
    pub en_bateria: bool,
    #[serde(rename = "ramTotalMB")]
    pub ram_total_mb: u64,
    pub nucleos_totales: u64,
    /// Lo último que quedó aplicado; None si todavía no se aplicó nada en esta sesión.
    pub aplicado: Option<Aplicado>,
    pub error: Option<String>,
    pub aplicando: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const R: RendimientoSettings = RendimientoSettings {
        enchufada: PerfilRendimiento { ram_mb: 8192, nucleos: 8 },
        bateria: PerfilRendimiento { ram_mb: 4096, nucleos: 4 },
        bateria_distinta: true,
    };

    fn perfil(ram_mb: u64, nucleos: u64) -> PerfilRendimiento {
        PerfilRendimiento { ram_mb, nucleos }
    }

    #[test]
    fn perfil_vigente_usa_el_de_bateria_solo_si_esta_a_bateria_y_el_ajuste_esta_prendido() {
        assert_eq!(perfil_vigente(&R, true), R.bateria);
        assert_eq!(perfil_vigente(&R, false), R.enchufada);
        assert_eq!(perfil_vigente(&RendimientoSettings { bateria_distinta: false, ..R }, true), R.enchufada);
    }

    #[test]
    fn limites_de_arma_la_mascara_con_los_primeros_nucleos() {
        assert_eq!(limites_de(perfil(4096, 4), 32_000, 14), Limites { ram_mb: 4096, nucleos: 4, afinidad: "15".into() });
        assert_eq!(limites_de(perfil(0, 1), 32_000, 14).afinidad, "1");
    }

    #[test]
    fn limites_de_cero_o_mas_de_lo_que_hay_es_sin_limite_y_los_nucleos_vuelven_como_mascara_completa() {
        let l = limites_de(perfil(0, 0), 32_000, 14);
        assert_eq!(l, Limites { ram_mb: 0, nucleos: 14, afinidad: "16383".into() });
        assert!(sin_limites(&l, 14));
        assert_eq!(limites_de(perfil(64_000, 99), 32_000, 14).ram_mb, 0);
        assert_eq!(limites_de(perfil(64_000, 99), 32_000, 14).nucleos, 14);
        assert!(!sin_limites(&limites_de(perfil(4096, 0), 32_000, 14), 14));
    }

    #[test]
    fn limites_de_con_64_nucleos_o_mas_no_se_pasa_de_un_grupo_de_afinidad() {
        let l = limites_de(perfil(0, 0), 32_000, 128);
        assert_eq!(l.nucleos, 64);
        assert_eq!(l.afinidad, u64::MAX.to_string());
        assert!(sin_limites(&l, 128));
    }

    #[test]
    fn limites_de_sin_nucleos_detectados_deja_al_menos_uno() {
        assert_eq!(limites_de(perfil(0, 0), 32_000, 0).nucleos, 1);
    }

    fn pedido(raiz: f64, dueno: f64, limites: Limites) -> PedidoJob {
        PedidoJob { nombre: "x".into(), raiz, incluir_raiz: false, excluir: String::new(), limites, dueno }
    }

    #[test]
    fn entorno_job_pasa_todo_como_texto_y_rechaza_pids_invalidos() {
        let limites = limites_de(perfil(2048, 2), 32_000, 14);
        let p = PedidoJob { nombre: nombre_job(42), raiz: 42.0, incluir_raiz: true, excluir: String::new(), limites: limites.clone(), dueno: 42.0 };
        let e = entorno_job(&p).unwrap();
        let esperado: BTreeMap<String, String> = [
            ("SLOTH_JOB_NOMBRE", "Local\\Sloth-Rendimiento-42".to_string()),
            ("SLOTH_JOB_RAIZ", "42".to_string()),
            ("SLOTH_JOB_INCLUIR_RAIZ", "1".to_string()),
            ("SLOTH_JOB_EXCLUIR", String::new()),
            ("SLOTH_JOB_RAM_BYTES", (2048u64 * 1024 * 1024).to_string()),
            ("SLOTH_JOB_AFINIDAD", "3".to_string()),
            ("SLOTH_JOB_DUENO", "42".to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        assert_eq!(e, esperado);
        for raiz in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
            assert!(entorno_job(&pedido(raiz, 1.0, limites.clone())).is_err(), "{raiz}");
        }
        assert!(entorno_job(&pedido(1.0, 0.0, limites)).is_err());
    }

    #[test]
    fn leer_salida_job_lee_la_ultima_linea_y_rechaza_lo_que_no_esperaba() {
        assert_eq!(leer_salida_job("aviso\r\n{\"procesos\":3,\"vistos\":4}\r\n").unwrap(), SalidaJob { procesos: 3.0, vistos: 4.0 });
        assert!(leer_salida_job("").is_err());
        assert!(leer_salida_job("{\"procesos\":\"3\"}").is_err());
        assert!(leer_salida_job("[1]").is_err());
        assert!(leer_salida_job("null").is_err());
    }

    #[test]
    fn el_estado_sale_en_camel_case_con_los_limites_aplanados() {
        let limites = limites_de(perfil(2048, 2), 32_000, 14);
        let e = EstadoRendimiento {
            soportado: true,
            en_bateria: false,
            ram_total_mb: 32_000,
            nucleos_totales: 14,
            aplicado: Some(Aplicado { limites, procesos: 3.0, en: 10.0 }),
            error: None,
            aplicando: false,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({
                "soportado": true, "enBateria": false, "ramTotalMB": 32000, "nucleosTotales": 14,
                "aplicado": { "ramMB": 2048, "nucleos": 2, "afinidad": "3", "procesos": 3.0, "en": 10.0 },
                "error": null, "aplicando": false
            })
        );
    }
}
