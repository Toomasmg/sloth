//! Contrato de «Celular»: lo que devuelve `/api/estado` (la página del celu) y lo que ve el panel de Sloth. Equivale a
//! `src/shared/celular.ts`. El orden de los campos y los que faltan (en vez de `null`) son los del JSON de TypeScript.
use serde::{Serialize, Serializer};

pub const PUERTO_POR_DEFECTO: u16 = 47321;

/// Un número como lo escribe `JSON.stringify`: los enteros sin «.0».
pub fn numero_js<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

fn numero_js_opcional<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(n) => numero_js(n, s),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EstadoSesion {
    Waiting,
    Done,
    Working,
    Idle,
    Sleeping,
    Exited,
}

impl EstadoSesion {
    pub fn desde_texto(t: &str) -> Option<Self> {
        Some(match t {
            "waiting" => Self::Waiting,
            "done" => Self::Done,
            "working" => Self::Working,
            "idle" => Self::Idle,
            "sleeping" => Self::Sleeping,
            "exited" => Self::Exited,
            _ => return None,
        })
    }

    /// Qué tan urgente es: lo que te necesita, primero.
    pub fn orden(self) -> u8 {
        self as u8
    }
}

/// Una ventana de límite (5 h o semanal), tal como la manda Claude Code en la statusline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct VentanaLimite {
    /// 0 a 100.
    #[serde(serialize_with = "numero_js")]
    pub pct: f64,
    /// Cuándo se reinicia (ms), si se sabe.
    #[serde(rename = "reiniciaEn", serialize_with = "numero_js_opcional")]
    pub reinicia_en: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsoDelDia {
    #[serde(serialize_with = "numero_js")]
    pub tokens: f64,
    pub mensajes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CuentaCelular {
    pub id: String,
    pub nombre: String,
    /// null: Claude todavía no mandó el dato para esta cuenta («sin datos», nunca 0 %).
    #[serde(rename = "cincoHoras")]
    pub cinco_horas: Option<VentanaLimite>,
    pub semana: Option<VentanaLimite>,
    #[serde(rename = "limitesLeidosEn")]
    pub limites_leidos_en: Option<i64>,
    pub hoy: Option<UsoDelDia>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SesionCelular {
    pub id: String,
    pub nombre: String,
    #[serde(rename = "cuentaId")]
    pub cuenta_id: String,
    pub estado: EstadoSesion,
    /// Desde cuándo está en ese estado (ms, reloj de la PC).
    pub desde: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detalle: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PedidoCelular {
    pub id: String,
    #[serde(rename = "sesionId")]
    pub sesion_id: String,
    pub sesion: String,
    /// Qué pide: el comando entero, el archivo o el host (hasta `MAX_PEDIDO` caracteres, sin caracteres invisibles).
    pub texto: String,
    pub titulo: String,
    /// Por qué se marca «Destructivo», o null.
    pub destructivo: Option<String>,
    /// Más largo que `MAX_PEDIDO`: el celu no lo ve entero, así que solo puede rechazarlo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cortado: Option<bool>,
    pub desde: i64,
    pub vence: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EstadoCelular {
    /// Reloj de la PC (ms): el celu calcula «hace cuánto» contra esto, no contra su propio reloj.
    pub ahora: i64,
    pub aprobar: bool,
    pub terminal: bool,
    pub cuentas: Vec<CuentaCelular>,
    pub sesiones: Vec<SesionCelular>,
    pub pedidos: Vec<PedidoCelular>,
    /// Solo en «desde cualquier red»: la terminal está prendida, pero se abre con el QR del Wi-Fi. Va al final, como
    /// lo deja el spread de TypeScript al sumarlo a un estado que ya existe.
    #[serde(rename = "terminalEnWifi", skip_serializing_if = "Option::is_none")]
    pub terminal_en_wifi: Option<bool>,
}

/// Ver: solo mira. Aprobar: también responde permisos. Controlar: también abre las terminales.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NivelCelu {
    Ver,
    Aprobar,
    Controlar,
}

impl NivelCelu {
    pub fn desde_texto(t: &str) -> Option<Self> {
        match t {
            "ver" => Some(Self::Ver),
            "aprobar" => Some(Self::Aprobar),
            "controlar" => Some(Self::Controlar),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CeluConAcceso {
    pub id: String,
    /// «Android · Chrome» del día que entró: sale del user-agent, que se puede falsear.
    pub nombre: String,
    pub nivel: NivelCelu,
    pub creado: i64,
    /// Último pedido (redondeado a la hora): a los 30 días sin uso, la PC lo saca sola.
    pub ultimo: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PedidoEntrada {
    pub id: String,
    pub nombre: String,
    pub ip: String,
    /// El mismo código que muestra el celu: así se sabe que es ese y no otro.
    pub codigo: String,
    pub en: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CeluConectado {
    pub dispositivo: String,
    pub ip: String,
    pub desde: i64,
    pub ultimo: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoEventoCelu {
    Conecto,
    Aprobo,
    Rechazo,
    Abrio,
    Escribio,
    Entro,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EventoCelu {
    pub at: i64,
    pub tipo: TipoEventoCelu,
    pub celu: String,
    pub ip: String,
    /// Nombre del espacio (no en «conecto»).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub espacio: Option<String>,
    /// Escrituras o aperturas seguidas juntadas en un solo evento.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub veces: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EstadoRemoto {
    Apagado,
    SinChat,
    Conectando,
    Listo,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemotoVista {
    pub encendido: bool,
    /// Segunda llave para aprobar desde afuera; solo vale con `aprobar` prendido.
    pub aprobar: bool,
    pub estado: EstadoRemoto,
    /// Enlace del QR (con el secreto en el #), o null si no hay sesión de chat o está apagado.
    pub enlace: Option<String>,
    /// Hubo un `hola` del celu en los últimos 75 s.
    #[serde(rename = "celuActivo")]
    pub celu_activo: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NtfyVista {
    pub encendido: bool,
    pub tema: String,
    pub servidor: String,
    #[serde(rename = "conToken")]
    pub con_token: bool,
    pub privado: bool,
    #[serde(rename = "temaRenovado", skip_serializing_if = "Option::is_none")]
    pub tema_renovado: Option<bool>,
}

/// La misma página, también por Tailscale: fuera de casa y, con `tailscale serve`, por HTTPS.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TailscaleVista {
    pub encendido: bool,
    /// La IP de Tailscale de la PC (100.x), o null si Tailscale no está conectado.
    pub ip: Option<String>,
    pub enlace: Option<String>,
    /// La dirección de `tailscale serve` que cargó el usuario (https://<pc>.<tailnet>.ts.net).
    pub https: Option<String>,
    #[serde(rename = "enlaceHttps")]
    pub enlace_https: Option<String>,
    pub error: Option<String>,
}

/// Lo que el panel «Celular» de Sloth necesita mostrar.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CelularVista {
    pub encendido: bool,
    /// Escuchando de verdad (se pudo abrir el puerto).
    pub escuchando: bool,
    pub ip: Option<String>,
    pub puerto: u16,
    /// http://<ip>:<puerto>/#k=<clave>, o null si no hay IP o está apagado.
    pub enlace: Option<String>,
    pub aprobar: bool,
    pub terminal: bool,
    pub ntfy: NtfyVista,
    pub error: Option<String>,
    /// La IP cambió desde que se abrió el servidor: el QR viejo ya no sirve.
    #[serde(rename = "ipCambio")]
    pub ip_cambio: bool,
    pub remoto: RemotoVista,
    pub celus: Vec<CeluConectado>,
    pub actividad: Vec<EventoCelu>,
    #[serde(rename = "conAcceso")]
    pub con_acceso: Vec<CeluConAcceso>,
    pub entradas: Vec<PedidoEntrada>,
    pub tailscale: TailscaleVista,
}

/// Cómo se lee un evento en el panel: «Aprobó un permiso en api», «Escribió en la terminal de web (12 veces)».
pub fn texto_evento(e: &EventoCelu) -> String {
    let donde = e.espacio.as_deref().unwrap_or("un espacio");
    match e.tipo {
        TipoEventoCelu::Conecto => "Se conectó".into(),
        TipoEventoCelu::Entro => "Lo dejaste entrar".into(),
        TipoEventoCelu::Aprobo => format!("Aprobó un permiso en {donde}"),
        TipoEventoCelu::Rechazo => format!("Rechazó un permiso en {donde}"),
        TipoEventoCelu::Abrio => format!("Abrió la terminal de {donde}"),
        TipoEventoCelu::Escribio => match e.veces {
            Some(v) if v > 1 => format!("Escribió en la terminal de {donde} ({v} veces)"),
            _ => format!("Escribió en la terminal de {donde}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn evento(tipo: TipoEventoCelu, espacio: Option<&str>, veces: Option<u32>) -> EventoCelu {
        EventoCelu { at: 1, tipo, celu: "Android · Chrome".into(), ip: "10.0.0.2".into(), espacio: espacio.map(Into::into), veces }
    }

    #[test]
    fn el_estado_se_serializa_con_el_orden_y_los_nombres_del_typescript() {
        let e = EstadoCelular {
            ahora: 1000,
            aprobar: false,
            terminal: true,
            terminal_en_wifi: None,
            cuentas: vec![CuentaCelular {
                id: "a".into(),
                nombre: "Fusion".into(),
                cinco_horas: Some(VentanaLimite { pct: 50.0, reinicia_en: None }),
                semana: Some(VentanaLimite { pct: 72.4, reinicia_en: Some(1_800_000_000_500.0) }),
                limites_leidos_en: Some(900),
                hoy: Some(UsoDelDia { tokens: 1500.0, mensajes: 12 }),
            }],
            sesiones: vec![SesionCelular { id: "w1".into(), nombre: "web".into(), cuenta_id: "a".into(), estado: EstadoSesion::Waiting, desde: 100, detalle: Some("Bash".into()) }],
            pedidos: vec![],
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"ahora":1000,"aprobar":false,"terminal":true,"cuentas":[{"id":"a","nombre":"Fusion","cincoHoras":{"pct":50,"reiniciaEn":null},"semana":{"pct":72.4,"reiniciaEn":1800000000500},"limitesLeidosEn":900,"hoy":{"tokens":1500,"mensajes":12}}],"sesiones":[{"id":"w1","nombre":"web","cuentaId":"a","estado":"waiting","desde":100,"detalle":"Bash"}],"pedidos":[]}"#
        );
    }

    #[test]
    fn terminal_en_wifi_va_al_final_y_solo_si_esta() {
        let mut e = EstadoCelular { ahora: 1, aprobar: false, terminal: false, terminal_en_wifi: Some(true), cuentas: vec![], sesiones: vec![], pedidos: vec![] };
        assert!(serde_json::to_string(&e).unwrap().ends_with(r#""pedidos":[],"terminalEnWifi":true}"#));
        e.terminal_en_wifi = None;
        assert!(!serde_json::to_string(&e).unwrap().contains("terminalEnWifi"));
    }

    #[test]
    fn un_pedido_sin_cortar_no_lleva_cortado() {
        let p = PedidoCelular { id: "p1".into(), sesion_id: "w1".into(), sesion: "web".into(), texto: "npm test".into(), titulo: "t".into(), destructivo: None, cortado: None, desde: 950, vence: 5000 };
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({ "id": "p1", "sesionId": "w1", "sesion": "web", "texto": "npm test", "titulo": "t", "destructivo": null, "desde": 950, "vence": 5000 }));
    }

    #[test]
    fn los_estados_y_niveles_usan_los_textos_de_siempre() {
        assert_eq!(serde_json::to_string(&EstadoSesion::Sleeping).unwrap(), "\"sleeping\"");
        assert_eq!(serde_json::to_string(&EstadoRemoto::SinChat).unwrap(), "\"sin-chat\"");
        assert_eq!(NivelCelu::desde_texto("controlar"), Some(NivelCelu::Controlar));
        assert_eq!(NivelCelu::desde_texto("root"), None);
        assert_eq!(EstadoSesion::desde_texto("waiting"), Some(EstadoSesion::Waiting));
        assert_eq!(EstadoSesion::desde_texto("otro"), None);
        assert!(EstadoSesion::Waiting.orden() < EstadoSesion::Exited.orden());
    }

    #[test]
    fn texto_evento_se_lee_como_en_el_panel() {
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Conecto, None, None)), "Se conectó");
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Entro, None, None)), "Lo dejaste entrar");
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Aprobo, Some("api"), None)), "Aprobó un permiso en api");
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Rechazo, None, None)), "Rechazó un permiso en un espacio");
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Abrio, Some("web"), None)), "Abrió la terminal de web");
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Escribio, Some("web"), Some(12))), "Escribió en la terminal de web (12 veces)");
        assert_eq!(texto_evento(&evento(TipoEventoCelu::Escribio, Some("web"), Some(1))), "Escribió en la terminal de web");
    }
}
