//! Quién entra al celu: los celus con acceso (cada uno con su clave y un nivel), los pedidos de entrada que esperan que
//! en la PC toquen «Dejar entrar» y la migración de `celular.json` de v1 a v2. Equivale a `celular-acceso.ts`.
use super::actividad::{dispositivo_de, Quien};
use super::core::clave_valida;
use super::largo_utf16;
use super::tipos::{CeluConAcceso, NivelCelu, PedidoEntrada};
use crate::versionado::{Migracion, Migraciones, Objeto};
use serde_json::{json, Value};
use std::collections::HashSet;

/// v2: cada celu tiene su clave; la del QR solo sirve para pedir entrar.
pub const VERSION_CELULAR: u32 = 2;
pub const VENCE_SIN_USO_MS: i64 = 30 * 24 * 3600_000;
/// `ultimo` se guarda redondeado: no hace falta escribir el archivo en cada pedido.
pub const ANOTAR_USO_MS: i64 = 3600_000;
pub const ENTRADA_MS: i64 = 5 * 60_000;
pub const MAX_ENTRADAS: usize = 5;
pub const MAX_CELUS: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct CeluGuardado {
    pub id: String,
    pub nombre: String,
    pub clave: String,
    pub nivel: NivelCelu,
    pub creado: i64,
    pub ultimo: i64,
}

impl CeluGuardado {
    /// Como va en `celular.json`: con la clave.
    pub fn a_json(&self) -> Value {
        let nivel = match self.nivel {
            NivelCelu::Ver => "ver",
            NivelCelu::Aprobar => "aprobar",
            NivelCelu::Controlar => "controlar",
        };
        json!({ "id": self.id, "nombre": self.nombre, "clave": self.clave, "nivel": nivel, "creado": self.creado, "ultimo": self.ultimo })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoEntrada {
    Esperando,
    Listo,
    Rechazado,
    Vencido,
}

impl EstadoEntrada {
    pub fn como_texto(self) -> &'static str {
        match self {
            Self::Esperando => "esperando",
            Self::Listo => "listo",
            Self::Rechazado => "rechazado",
            Self::Vencido => "vencido",
        }
    }
}

/// Lo que el celu puede hacer: lo que deja su nivel y, encima, lo que prenden los interruptores del panel.
pub fn permisos_de(nivel: NivelCelu, aprobar: bool, terminal: bool) -> (bool, bool) {
    (aprobar && nivel != NivelCelu::Ver, terminal && nivel == NivelCelu::Controlar)
}

/// v1 tenía una sola clave, la del QR, que daba acceso a cualquiera que la tuviera. Los celus que ya la usaban siguen
/// entrando como «Celus emparejados antes» (se pueden sacar desde el panel); el QR pasa a tener una clave nueva, que
/// genera quien carga al no encontrarla.
pub fn migraciones_celular(ahora: i64) -> Migraciones {
    let v1: Migracion = Box::new(move |d: Objeto| {
        let mut resto = d;
        let clave = resto.shift_remove("clave");
        let celus = match clave {
            Some(Value::String(c)) if clave_valida(&c) => {
                vec![CeluGuardado { id: "antes".into(), nombre: "Celus emparejados antes".into(), clave: c, nivel: NivelCelu::Controlar, creado: ahora, ultimo: ahora }.a_json()]
            }
            _ => vec![],
        };
        resto.insert("celus".into(), Value::Array(celus));
        Ok(resto)
    });
    let mut m = Migraciones::new();
    m.insert(1, v1);
    m
}

fn id_valido(id: &str) -> bool {
    (1..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn es_finito(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n as i64)
}

fn leer_celu(v: &Value) -> Option<CeluGuardado> {
    let c = v.as_object()?;
    let id = c.get("id")?.as_str().filter(|i| id_valido(i))?;
    let nombre = c.get("nombre")?.as_str().filter(|n| largo_utf16(n) <= 80)?;
    let clave = c.get("clave")?.as_str().filter(|k| clave_valida(k))?;
    let nivel = NivelCelu::desde_texto(c.get("nivel")?.as_str()?)?;
    Some(CeluGuardado { id: id.into(), nombre: nombre.into(), clave: clave.into(), nivel, creado: es_finito(c.get("creado"))?, ultimo: es_finito(c.get("ultimo"))? })
}

/// Los celus de un archivo ya migrado: sin los rotos, los vencidos ni claves repetidas (o iguales a la del QR).
pub fn leer_celus(v: Option<&Value>, ahora: i64, clave_qr: Option<&str>) -> Vec<CeluGuardado> {
    let Some(Value::Array(lista)) = v else { return vec![] };
    let mut vistas: HashSet<String> = clave_qr.map(String::from).into_iter().collect();
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for c in lista {
        let Some(c) = leer_celu(c) else { continue };
        if vistas.contains(&c.clave) || ids.contains(&c.id) || ahora - c.ultimo > VENCE_SIN_USO_MS {
            continue;
        }
        vistas.insert(c.clave.clone());
        ids.insert(c.id.clone());
        out.push(c);
    }
    let desde = out.len().saturating_sub(MAX_CELUS);
    out.split_off(desde)
}

pub fn sin_vencidos(celus: &[CeluGuardado], ahora: i64) -> Vec<CeluGuardado> {
    celus.iter().filter(|c| ahora - c.ultimo <= VENCE_SIN_USO_MS).cloned().collect()
}

/// Para el panel: nunca la clave.
pub fn para_vista(celus: &[CeluGuardado]) -> Vec<CeluConAcceso> {
    celus.iter().map(|c| CeluConAcceso { id: c.id.clone(), nombre: c.nombre.clone(), nivel: c.nivel, creado: c.creado, ultimo: c.ultimo }).collect()
}

/// true si hay que anotar el uso (y guardar): pasó más de una hora desde lo anotado.
pub fn usar(c: &mut CeluGuardado, ahora: i64) -> bool {
    if ahora - c.ultimo < ANOTAR_USO_MS {
        return false;
    }
    c.ultimo = ahora;
    true
}

struct Entrada {
    id: String,
    clave: String,
    codigo: String,
    nombre: String,
    ip: String,
    ua: String,
    en: i64,
    /// Solo `Esperando`, `Listo` o `Rechazado`: un pedido vencido se borra.
    estado: EstadoEntrada,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultadoPedir {
    Codigo(String),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Respondido {
    pub clave: String,
    pub nombre: String,
    pub ip: String,
    pub ua: String,
}

fn al_azar(max: u32) -> u32 {
    // Sin sesgo: se tira lo que cae en el resto incompleto.
    let tope = u32::MAX - (u32::MAX % max);
    loop {
        let mut b = [0u8; 4];
        getrandom::getrandom(&mut b).expect("el sistema operativo da bytes al azar");
        let n = u32::from_le_bytes(b);
        if n < tope {
            return n % max;
        }
    }
}

fn id_al_azar() -> String {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).expect("el sistema operativo da bytes al azar");
    hex::encode(b)
}

/// Los celus que escanearon el QR y esperan. Cada uno manda la clave que generó; la PC muestra el código que le devolvió,
/// y recién cuando alguien toca «Dejar entrar» esa clave sirve. En memoria: al cerrar Sloth, se pierden.
#[derive(Default)]
pub struct Entradas {
    // En orden de alta, como un `Map` de JavaScript.
    lista: Vec<Entrada>,
}

impl Entradas {
    fn podar(&mut self, ahora: i64) {
        self.lista.retain(|e| ahora - e.en <= ENTRADA_MS);
    }

    fn esperando(&self) -> impl Iterator<Item = &Entrada> {
        self.lista.iter().filter(|e| e.estado == EstadoEntrada::Esperando)
    }

    /// Un pedido repetido (la respuesta se perdió) devuelve el mismo código.
    pub fn pedir(&mut self, clave: &str, q: &Quien, ahora: i64) -> ResultadoPedir {
        self.podar(ahora);
        if let Some(previa) = self.lista.iter().find(|e| e.clave == clave) {
            return if previa.estado == EstadoEntrada::Esperando { ResultadoPedir::Codigo(previa.codigo.clone()) } else { ResultadoPedir::Error("Ese pedido ya se respondió. Escaneá el QR de nuevo.".into()) };
        }
        if self.esperando().count() >= MAX_ENTRADAS {
            return ResultadoPedir::Error("Hay demasiados celus esperando. Respondelos en la PC y probá de nuevo.".into());
        }
        let usados: HashSet<&str> = self.esperando().map(|e| e.codigo.as_str()).collect();
        let codigo = loop {
            let c = format!("{:04}", al_azar(10_000));
            if !usados.contains(c.as_str()) {
                break c;
            }
        };
        self.lista.push(Entrada { id: id_al_azar(), clave: clave.into(), codigo: codigo.clone(), nombre: dispositivo_de(&q.ua), ip: q.ip.clone(), ua: q.ua.clone(), en: ahora, estado: EstadoEntrada::Esperando });
        ResultadoPedir::Codigo(codigo)
    }

    pub fn estado(&mut self, clave: &str, ahora: i64) -> EstadoEntrada {
        self.podar(ahora);
        self.lista.iter().find(|e| e.clave == clave).map_or(EstadoEntrada::Vencido, |e| e.estado)
    }

    /// Devuelve el pedido si estaba esperando; si no (ya respondido, vencido, otro id), None.
    pub fn responder(&mut self, id: &str, si: bool, ahora: i64) -> Option<Respondido> {
        self.podar(ahora);
        let e = self.lista.iter_mut().find(|x| x.id == id)?;
        if e.estado != EstadoEntrada::Esperando {
            return None;
        }
        e.estado = if si { EstadoEntrada::Listo } else { EstadoEntrada::Rechazado };
        Some(Respondido { clave: e.clave.clone(), nombre: e.nombre.clone(), ip: e.ip.clone(), ua: e.ua.clone() })
    }

    pub fn pendientes(&mut self, ahora: i64) -> Vec<PedidoEntrada> {
        self.podar(ahora);
        self.esperando().map(|e| PedidoEntrada { id: e.id.clone(), nombre: e.nombre.clone(), ip: e.ip.clone(), codigo: e.codigo.clone(), en: e.en }).collect()
    }

    /// El próximo vencimiento, para repintar el panel cuando un pedido caduca.
    pub fn proximo_vence(&self, ahora: i64) -> Option<i64> {
        self.esperando().map(|e| e.en + ENTRADA_MS - ahora).min().map(|t| t.max(0))
    }

    pub fn olvidar(&mut self) {
        self.lista.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::clave_de;
    use crate::versionado::{migrar, EstadoVersion};

    const AHORA: i64 = 1_800_000_000_000;
    const UA: &str = "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36";

    fn quien() -> Quien {
        Quien::nuevo("192.168.1.40", UA)
    }

    fn celu(id: &str, clave: String, nivel: NivelCelu) -> CeluGuardado {
        CeluGuardado { id: id.into(), nombre: "Android · Chrome".into(), clave, nivel, creado: AHORA, ultimo: AHORA }
    }

    /// Así era celular.json antes de numerarlo (v1): una sola clave para todos.
    fn archivo_v1() -> Value {
        serde_json::from_str(include_str!("fixtures/celular-v1.json")).unwrap()
    }

    #[test]
    fn migrar_v1_la_clave_de_antes_queda_como_un_celu_con_acceso_y_el_qr_se_queda_sin_clave() {
        let entrada = archivo_v1();
        let r = migrar(&entrada, &migraciones_celular(AHORA), VERSION_CELULAR);
        assert_eq!(r.estado, EstadoVersion::Migrado);
        assert_eq!(r.datos["version"], 2);
        assert!(r.datos.get("clave").is_none());
        assert_eq!(r.datos["celus"], json!([{ "id": "antes", "nombre": "Celus emparejados antes", "clave": clave_de(7), "nivel": "controlar", "creado": AHORA, "ultimo": AHORA }]));
        assert_eq!(r.datos["campoQueNoConozco"], 1, "lo desconocido se conserva");
        assert_eq!(r.datos["aprobar"], true);
        assert_eq!(entrada["clave"], clave_de(7), "no muta la entrada");
        let claves: Vec<&String> = r.datos.as_object().unwrap().keys().collect();
        assert_eq!(claves, ["encendido", "puerto", "aprobar", "terminal", "ntfy", "remoto", "campoQueNoConozco", "celus", "version"], "el orden de las claves se conserva");
    }

    #[test]
    fn migrar_v1_sin_clave_valida_ningun_celu_queda_adentro() {
        let mut v1 = archivo_v1();
        v1["clave"] = json!("corta");
        let r = migrar(&v1, &migraciones_celular(AHORA), VERSION_CELULAR);
        assert_eq!(r.datos["celus"], json!([]));
    }

    #[test]
    fn una_version_mas_nueva_que_la_app_no_se_toca() {
        let futuro = json!({ "version": 3, "celus": "otra cosa" });
        let r = migrar(&futuro, &migraciones_celular(AHORA), VERSION_CELULAR);
        assert_eq!(r.estado, EstadoVersion::Futura);
        assert_eq!(r.datos, futuro);
    }

    #[test]
    fn leer_celus_descarta_los_rotos_los_vencidos_las_claves_repetidas_y_la_del_qr() {
        let bien = celu("a1", clave_de(7), NivelCelu::Aprobar);
        let otra = clave_de(8);
        let con = |id: &str, clave: String, ultimo: i64, nivel: &str| {
            let mut v = bien.a_json();
            v["id"] = json!(id);
            v["clave"] = json!(clave);
            v["ultimo"] = json!(ultimo);
            v["nivel"] = json!(nivel);
            v
        };
        let lista = json!([
            bien.a_json(),
            con("a2", clave_de(7), AHORA, "aprobar"),
            con("viejo", clave_de(1), AHORA - VENCE_SIN_USO_MS - 1, "aprobar"),
            con("qr", otra.clone(), AHORA, "aprobar"),
            con("nivel", clave_de(2), AHORA, "root"),
            con("mal id!", clave_de(3), AHORA, "aprobar"),
            "cualquier cosa"
        ]);
        assert_eq!(leer_celus(Some(&lista), AHORA, Some(&otra)), vec![bien]);
        assert!(leer_celus(Some(&json!("no")), AHORA, None).is_empty());
        assert!(leer_celus(None, AHORA, None).is_empty());
    }

    #[test]
    fn leer_celus_se_queda_con_los_ultimos_20() {
        let lista: Vec<Value> = (0..25u8).map(|i| celu(&format!("c{i}"), clave_de(20 + i), NivelCelu::Ver).a_json()).collect();
        let r = leer_celus(Some(&Value::Array(lista)), AHORA, None);
        assert_eq!(r.len(), MAX_CELUS);
        assert_eq!(r[0].id, "c5");
        assert_eq!(r[19].id, "c24");
    }

    #[test]
    fn sin_vencidos_saca_los_que_pasaron_30_dias_sin_usarse() {
        let c = celu("a", clave_de(7), NivelCelu::Ver);
        assert_eq!(sin_vencidos(&[c.clone()], AHORA + VENCE_SIN_USO_MS).len(), 1);
        assert_eq!(sin_vencidos(&[c], AHORA + VENCE_SIN_USO_MS + 1).len(), 0);
    }

    #[test]
    fn usar_anota_el_uso_a_lo_sumo_una_vez_por_hora() {
        let mut c = celu("a", clave_de(7), NivelCelu::Ver);
        assert!(!usar(&mut c, AHORA + 60_000));
        assert!(usar(&mut c, AHORA + 3600_000));
        assert_eq!(c.ultimo, AHORA + 3600_000);
    }

    #[test]
    fn el_panel_nunca_recibe_la_clave() {
        let c = CeluGuardado { id: "a".into(), nombre: "x".into(), clave: clave_de(7), nivel: NivelCelu::Ver, creado: 1, ultimo: 2 };
        let v = para_vista(&[c]);
        assert_eq!(serde_json::to_value(&v).unwrap(), json!([{ "id": "a", "nombre": "x", "nivel": "ver", "creado": 1, "ultimo": 2 }]));
        assert!(!serde_json::to_string(&v).unwrap().contains(&clave_de(7)));
    }

    #[test]
    fn el_nivel_nunca_da_mas_de_lo_que_prenden_los_interruptores() {
        assert_eq!(permisos_de(NivelCelu::Ver, true, true), (false, false));
        assert_eq!(permisos_de(NivelCelu::Aprobar, true, true), (true, false));
        assert_eq!(permisos_de(NivelCelu::Controlar, true, true), (true, true));
        assert_eq!(permisos_de(NivelCelu::Controlar, false, false), (false, false));
    }

    #[test]
    fn entradas_pedir_da_un_codigo_de_4_digitos_y_el_mismo_pedido_repetido_el_mismo_codigo() {
        let mut e = Entradas::default();
        let r = e.pedir(&clave_de(7), &quien(), AHORA);
        let ResultadoPedir::Codigo(codigo) = &r else { panic!("{r:?}") };
        assert!(codigo.len() == 4 && codigo.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(e.pedir(&clave_de(7), &quien(), AHORA + 1000), r);
        let p = e.pendientes(AHORA).remove(0);
        assert_eq!(p.nombre, "Android · Chrome");
        assert_eq!(p.ip, quien().ip);
        assert_eq!(&p.codigo, codigo);
        assert!(!serde_json::to_string(&e.pendientes(AHORA)).unwrap().contains(&clave_de(7)), "la clave del celu no va al panel");
    }

    #[test]
    fn entradas_dejar_entrar_rechazar_y_lo_que_vence() {
        let (qr, otra) = (clave_de(7), clave_de(8));
        let mut e = Entradas::default();
        e.pedir(&qr, &quien(), AHORA);
        e.pedir(&otra, &quien(), AHORA);
        let pend = e.pendientes(AHORA);
        let (a, b) = (&pend[0], &pend[1]);
        assert_eq!(e.estado(&qr, AHORA), EstadoEntrada::Esperando);
        let si = e.responder(&a.id, true, AHORA).expect("estaba esperando");
        assert_eq!(e.estado(&si.clave, AHORA), EstadoEntrada::Listo);
        assert!(e.responder(&a.id, false, AHORA).is_none(), "no se responde dos veces");
        e.responder(&b.id, false, AHORA);
        assert!(e.pendientes(AHORA).is_empty());
        assert!(matches!(e.pedir(&si.clave, &quien(), AHORA), ResultadoPedir::Error(_)), "una clave ya respondida no vuelve a pedir");
        assert_eq!(e.estado(&qr, AHORA + ENTRADA_MS + 1), EstadoEntrada::Vencido);
        assert!(e.responder(&b.id, true, AHORA + ENTRADA_MS + 1).is_none());
    }

    #[test]
    fn entradas_con_muchos_esperando_no_se_aceptan_mas() {
        let mut e = Entradas::default();
        for i in 0..MAX_ENTRADAS as u8 {
            assert!(matches!(e.pedir(&clave_de(20 + i), &quien(), AHORA), ResultadoPedir::Codigo(_)));
        }
        assert!(matches!(e.pedir(&clave_de(7), &quien(), AHORA), ResultadoPedir::Error(_)));
        let codigos: HashSet<String> = e.pendientes(AHORA).into_iter().map(|p| p.codigo).collect();
        assert_eq!(codigos.len(), MAX_ENTRADAS, "códigos distintos");
        assert!(matches!(e.pedir(&clave_de(7), &quien(), AHORA + ENTRADA_MS + 1), ResultadoPedir::Codigo(_)), "al vencer los de antes, entra");
    }

    #[test]
    fn proximo_vence_dice_cuanto_falta_para_que_caduque_el_primero_que_espera() {
        let mut e = Entradas::default();
        assert_eq!(e.proximo_vence(AHORA), None);
        e.pedir(&clave_de(7), &quien(), AHORA);
        assert_eq!(e.proximo_vence(AHORA + 1000), Some(ENTRADA_MS - 1000));
        assert_eq!(e.proximo_vence(AHORA + ENTRADA_MS + 5000), Some(0));
    }
}
