//! Qué celus le hablan a la PC y qué hicieron: hora, celu, qué y en qué espacio; nunca lo que se escribió ni el comando.
//! Vive en memoria: se pierde al cerrar Sloth. Equivale a `celular-actividad.ts`.
use super::tipos::{CeluConectado, EventoCelu, TipoEventoCelu};

/// Quién hizo un pedido: la IP y el user-agent que mandó el navegador del celu.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Quien {
    pub ip: String,
    pub ua: String,
    /// El celu con acceso cuya clave abrió el pedido; sin él, el pedido vino con la clave del QR.
    pub celu: Option<String>,
}

impl Quien {
    pub fn nuevo(ip: &str, ua: &str) -> Self {
        Quien { ip: ip.into(), ua: ua.into(), celu: None }
    }
}

/// «Android · Chrome», «iPhone · Safari»… Sirve para reconocerlo en el panel, no para identificarlo: el user-agent se puede falsear.
pub fn dispositivo_de(ua: &str) -> String {
    let tiene = |t: &str| ua.contains(t);
    let so = if tiene("iPhone") {
        "iPhone"
    } else if tiene("iPad") {
        "iPad"
    } else if tiene("Android") {
        "Android"
    } else if tiene("Windows") {
        "Windows"
    } else if tiene("Mac OS X") || tiene("Macintosh") {
        "Mac"
    } else if tiene("Linux") {
        "Linux"
    } else {
        "Otro"
    };
    let nav = if tiene("Edg/") || tiene("EdgA/") {
        "Edge"
    } else if tiene("SamsungBrowser/") {
        "Samsung Internet"
    } else if tiene("Firefox/") || tiene("FxiOS/") {
        "Firefox"
    } else if tiene("CriOS/") || tiene("Chrome/") {
        "Chrome"
    } else if tiene("Safari/") {
        "Safari"
    } else {
        "navegador"
    };
    format!("{so} · {nav}")
}

#[derive(Debug, Clone, Copy)]
pub struct OpcionesActividad {
    /// Sin pedidos en este tiempo, el celu deja de contar como conectado (la página consulta cada 1,5 s).
    pub activo_ms: i64,
    /// Vuelve después de tanto tiempo: cuenta como conexión nueva (y avisa).
    pub regreso_ms: i64,
    /// Escrituras seguidas en la misma terminal dentro de este tiempo se anotan como un solo evento.
    pub juntar_ms: i64,
    pub max_eventos: usize,
}

impl Default for OpcionesActividad {
    fn default() -> Self {
        OpcionesActividad { activo_ms: 20_000, regreso_ms: 10 * 60_000, juntar_ms: 60_000, max_eventos: 100 }
    }
}

struct Visto {
    id: String,
    ip: String,
    dispositivo: String,
    primero: i64,
    ultimo: i64,
}

#[derive(Default)]
pub struct Actividad {
    o: OpcionesActividad,
    celus: Vec<Visto>,
    /// Lo más nuevo primero.
    eventos: Vec<EventoCelu>,
}

impl Actividad {
    pub fn nueva(o: OpcionesActividad) -> Self {
        Actividad { o, celus: Vec::new(), eventos: Vec::new() }
    }

    fn sumar(&mut self, ev: EventoCelu) {
        self.eventos.insert(0, ev);
        self.eventos.truncate(self.o.max_eventos);
    }

    /// Un pedido válido (pasó la clave). Devuelve true si es un celu nuevo o que vuelve tras un rato: hay que avisar.
    pub fn visto(&mut self, q: &Quien, ahora: i64) -> bool {
        let dispositivo = dispositivo_de(&q.ua);
        let id = format!("{}|{}", q.ip, dispositivo);
        let nuevo = match self.celus.iter_mut().find(|c| c.id == id) {
            Some(c) => {
                let vuelve = ahora - c.ultimo >= self.o.regreso_ms;
                c.ultimo = ahora;
                vuelve
            }
            None => {
                self.celus.push(Visto { id, ip: q.ip.clone(), dispositivo: dispositivo.clone(), primero: ahora, ultimo: ahora });
                true
            }
        };
        if nuevo {
            self.sumar(EventoCelu { at: ahora, tipo: TipoEventoCelu::Conecto, celu: dispositivo, ip: q.ip.clone(), espacio: None, veces: None });
        }
        nuevo
    }

    /// Algo que hizo un celu. Devuelve false si se juntó con el evento anterior (solo sumó una vez más).
    pub fn anotar(&mut self, q: &Quien, tipo: TipoEventoCelu, espacio: &str, ahora: i64) -> bool {
        let celu = dispositivo_de(&q.ua);
        let juntar = self.o.juntar_ms;
        if matches!(tipo, TipoEventoCelu::Escribio | TipoEventoCelu::Abrio) {
            if let Some(previo) = self.eventos.first_mut() {
                if previo.tipo == tipo && previo.ip == q.ip && previo.celu == celu && previo.espacio.as_deref() == Some(espacio) && ahora - previo.at < juntar {
                    previo.at = ahora;
                    previo.veces = Some(previo.veces.unwrap_or(1) + 1);
                    return false;
                }
            }
        }
        self.sumar(EventoCelu { at: ahora, tipo, celu, ip: q.ip.clone(), espacio: Some(espacio.to_string()), veces: None });
        true
    }

    pub fn conectados(&self, ahora: i64) -> Vec<CeluConectado> {
        self.celus.iter().filter(|c| ahora - c.ultimo < self.o.activo_ms).map(|c| CeluConectado { dispositivo: c.dispositivo.clone(), ip: c.ip.clone(), desde: c.primero, ultimo: c.ultimo }).collect()
    }

    pub fn eventos(&self) -> Vec<EventoCelu> {
        self.eventos.clone()
    }

    /// Al regenerar el código: los celus de antes ya no entran. El registro queda.
    pub fn olvidar_celus(&mut self) {
        self.celus.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use TipoEventoCelu::*;

    const ANDROID: &str = "Mozilla/5.0 (Linux; Android 13; SM-G965F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
    const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

    #[test]
    fn dispositivo_de_reconoce_los_celus_comunes_y_no_rompe_con_lo_raro() {
        assert_eq!(dispositivo_de(ANDROID), "Android · Chrome");
        assert_eq!(dispositivo_de(IPHONE), "iPhone · Safari");
        assert_eq!(dispositivo_de("Mozilla/5.0 (iPhone) CriOS/120 Safari/604"), "iPhone · Chrome");
        assert_eq!(dispositivo_de("Mozilla/5.0 (Linux; Android 13) SamsungBrowser/23.0 Chrome/115 Safari/537"), "Android · Samsung Internet");
        assert_eq!(dispositivo_de(""), "Otro · navegador");
    }

    #[test]
    fn un_celu_nuevo_avisa_una_vez_mientras_sigue_consultando_no_y_al_volver_tras_un_rato_si() {
        let mut a = Actividad::nueva(OpcionesActividad { activo_ms: 20_000, regreso_ms: 600_000, ..Default::default() });
        let q = Quien::nuevo("192.168.0.23", ANDROID);
        assert!(a.visto(&q, 1000));
        assert!(!a.visto(&q, 2500));
        assert!(!a.visto(&q, 4000));
        assert_eq!(a.conectados(5000), vec![CeluConectado { dispositivo: "Android · Chrome".into(), ip: "192.168.0.23".into(), desde: 1000, ultimo: 4000 }]);
        assert!(a.conectados(4000 + 20_000).is_empty(), "sin consultar 20 s deja de estar conectado");
        assert!(a.visto(&q, 4000 + 600_000), "volvió después de 10 min");
        let tipos: Vec<_> = a.eventos().iter().map(|e| (e.tipo, e.celu.clone())).collect();
        assert_eq!(tipos, vec![(Conecto, "Android · Chrome".to_string()), (Conecto, "Android · Chrome".to_string())]);
    }

    #[test]
    fn dos_celus_en_la_misma_ip_se_cuentan_aparte() {
        let mut a = Actividad::default();
        assert!(a.visto(&Quien::nuevo("192.168.0.23", ANDROID), 1));
        assert!(a.visto(&Quien::nuevo("192.168.0.23", IPHONE), 2));
        assert_eq!(a.conectados(3).len(), 2);
    }

    #[test]
    fn las_escrituras_seguidas_en_la_misma_terminal_son_un_solo_evento_con_cuantas_veces() {
        let mut a = Actividad::nueva(OpcionesActividad { juntar_ms: 60_000, ..Default::default() });
        let q = Quien::nuevo("10.0.0.5", IPHONE);
        assert!(a.anotar(&q, Escribio, "web", 1000));
        assert!(!a.anotar(&q, Escribio, "web", 2000));
        assert!(!a.anotar(&q, Escribio, "web", 3000));
        assert!(a.anotar(&q, Escribio, "api", 4000));
        assert!(a.anotar(&q, Aprobo, "api", 5000));
        assert!(a.anotar(&q, Escribio, "api", 5000 + 61_000), "pasado el minuto, evento nuevo");
        let ev = a.eventos();
        let resumen: Vec<_> = ev.iter().map(|e| (e.tipo, e.espacio.clone().unwrap(), e.veces.unwrap_or(1))).collect();
        assert_eq!(resumen, vec![(Escribio, "api".to_string(), 1), (Aprobo, "api".to_string(), 1), (Escribio, "api".to_string(), 1), (Escribio, "web".to_string(), 3)]);
        assert_eq!(ev[3].at, 3000, "la hora es la de la última escritura");
    }

    #[test]
    fn el_registro_tiene_tope_y_olvidar_celus_no_lo_borra() {
        let mut a = Actividad::nueva(OpcionesActividad { max_eventos: 3, ..Default::default() });
        let q = Quien::nuevo("10.0.0.5", IPHONE);
        a.visto(&q, 1);
        for i in 0..5 {
            a.anotar(&q, Aprobo, &format!("ws{i}"), 10 + i);
        }
        let espacios: Vec<_> = a.eventos().into_iter().map(|e| e.espacio.unwrap()).collect();
        assert_eq!(espacios, ["ws4", "ws3", "ws2"]);
        a.olvidar_celus();
        assert!(a.conectados(20).is_empty());
        assert_eq!(a.eventos().len(), 3);
        assert!(a.visto(&q, 30), "después de regenerar, entrar de nuevo avisa");
    }

    #[test]
    fn dispositivo_de_coincide_con_el_typescript() {
        let f: serde_json::Value = serde_json::from_str(include_str!("fixtures/ts.json")).unwrap();
        for par in f["dispositivos"].as_array().unwrap() {
            assert_eq!(dispositivo_de(par[0].as_str().unwrap()), par[1].as_str().unwrap(), "{}", par[0]);
        }
    }
}
