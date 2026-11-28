//! Notas del release (markdown de GitHub) agrupadas en Nuevo / Mejoras / Arreglos, para que la interfaz no parsee
//! markdown. Equivale a src/main/features/updater-notes.ts: reconoce «## Nuevo», «### Mejoras», «## Arreglos» (con o sin
//! acentos ni dos puntos); otro encabezado queda como grupo propio y las viñetas sin encabezado van a «Novedades».
use super::cortar_utf16;
use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

const MAX_ITEMS: usize = 60;
const MAX_ITEM_LEN: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GrupoNotas {
    pub id: String,
    pub label: String,
    pub items: Vec<String>,
}

struct Fijo {
    id: &'static str,
    label: &'static str,
    re: Regex,
}

fn fijos() -> &'static [Fijo] {
    static F: OnceLock<Vec<Fijo>> = OnceLock::new();
    F.get_or_init(|| {
        let f = |id, label, re: &str| Fijo { id, label, re: Regex::new(re).expect("regex fija") };
        vec![
            f("nuevo", "Nuevo", r"^(nuevo|nuevos|novedades?|lo nuevo|features?)\b"),
            f("mejoras", "Mejoras", r"^(mejoras?|cambios?|improvements?)\b"),
            f("arreglos", "Arreglos", r"^(arreglos?|correcciones?|correccion|fix(es)?|bugs?)\b"),
        ]
    })
}

struct Res {
    autor: Regex,
    imagen: Regex,
    enlace: Regex,
    codigo: Regex,
    negrita: Regex,
    negrita_g: Regex,
    cursiva: Regex,
    html: Regex,
    blancos: Regex,
    encabezado: Regex,
    vineta: Regex,
    separador: Regex,
}

fn res() -> &'static Res {
    static R: OnceLock<Res> = OnceLock::new();
    R.get_or_init(|| {
        let r = |s: &str| Regex::new(s).expect("regex fija");
        Res {
            autor: r(r"(?i)\s+by @\S+\s+in\s+\S+$"),
            imagen: r(r"!\[[^\]]*\]\([^)]*\)"),
            enlace: r(r"\[([^\]]+)\]\([^)]*\)"),
            codigo: r(r"`([^`]*)`"),
            negrita: r(r"\*\*([^*]+)\*\*"),
            negrita_g: r(r"__([^_]+)__"),
            cursiva: r(r"\*([^*]+)\*"),
            html: r(r"<[^>]+>"),
            blancos: r(r"\s+"),
            encabezado: r(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*$"),
            vineta: r(r"^\s*(?:[-*+]|\d+[.)])\s+(.+)$"),
            separador: r(r"^\s*(---+|\*\*\*+)\s*$"),
        }
    })
}

/// Minúsculas, sin acentos ni puntuación ni emojis, para comparar encabezados.
fn norm(s: &str) -> String {
    let sin_marcas: String = s.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let limpio: String = sin_marcas.chars().map(|c| if c.is_alphabetic() || c.is_numeric() || c.is_whitespace() { c } else { ' ' }).collect();
    limpio.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Quita el markdown en línea que no se muestra en la interfaz.
pub fn plain(s: &str) -> String {
    let r = res();
    let s = r.autor.replace(s, "");
    let s = r.imagen.replace_all(&s, "");
    let s = r.enlace.replace_all(&s, "$1");
    let s = r.codigo.replace_all(&s, "$1");
    let s = r.negrita.replace_all(&s, "$1");
    let s = r.negrita_g.replace_all(&s, "$1");
    let s = r.cursiva.replace_all(&s, "$1");
    let s = r.html.replace_all(&s, "");
    let s = r.blancos.replace_all(&s, " ");
    cortar_utf16(s.trim(), MAX_ITEM_LEN)
}

#[derive(Default)]
struct Grupos {
    lista: Vec<GrupoNotas>,
}

impl Grupos {
    fn sumar(&mut self, id: &str, label: &str, item: String) {
        if item.is_empty() {
            return;
        }
        let i = match self.lista.iter().position(|g| g.id == id) {
            Some(i) => i,
            None => {
                self.lista.push(GrupoNotas { id: id.into(), label: label.into(), items: vec![] });
                self.lista.len() - 1
            }
        };
        if self.lista[i].items.len() < MAX_ITEMS {
            self.lista[i].items.push(item);
        }
    }
}

pub fn agrupar_notas(markdown: Option<&str>) -> Vec<GrupoNotas> {
    let r = res();
    let texto = markdown.unwrap_or("").replace("\r\n", "\n").replace('\r', "\n");
    let mut grupos = Grupos::default();
    let (mut id, mut label) = ("otros".to_string(), "Novedades".to_string());
    let mut hubo_vineta = false;
    let mut sueltas: Vec<String> = Vec::new();

    for crudo in texto.split('\n') {
        let linea = crudo.trim_end();
        if let Some(h) = r.encabezado.captures(linea) {
            let titulo = plain(&h[1]);
            let titulo = titulo.strip_suffix(':').unwrap_or(&titulo).trim().to_string();
            let n = norm(&titulo);
            match fijos().iter().find(|f| f.re.is_match(&n)) {
                Some(f) => (id, label) = (f.id.into(), f.label.into()),
                None => (id, label) = (format!("h:{n}"), if titulo.is_empty() { "Novedades".into() } else { titulo }),
            }
            continue;
        }
        if let Some(b) = r.vineta.captures(linea) {
            hubo_vineta = true;
            grupos.sumar(&id, &label, plain(&b[1]));
            continue;
        }
        if !linea.trim().is_empty() && !r.separador.is_match(linea) {
            sueltas.push(plain(linea));
        }
    }

    // Sin viñetas en ningún lado: el texto suelto son las novedades.
    if !hubo_vineta {
        for l in sueltas {
            grupos.sumar("otros", "Novedades", l);
        }
    }

    let es_fijo = |g: &GrupoNotas| fijos().iter().any(|f| f.id == g.id);
    let mut out: Vec<GrupoNotas> = fijos().iter().filter_map(|f| grupos.lista.iter().find(|g| g.id == f.id).cloned()).collect();
    out.extend(grupos.lista.into_iter().filter(|g| !es_fijo(g)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(id: &str, label: &str, items: &[&str]) -> GrupoNotas {
        GrupoNotas { id: id.into(), label: label.into(), items: items.iter().map(|s| s.to_string()).collect() }
    }

    fn ids(v: &[GrupoNotas]) -> Vec<&str> {
        v.iter().map(|x| x.id.as_str()).collect()
    }

    #[test]
    fn agrupa_por_encabezados_conocidos_y_los_ordena_nuevo_mejoras_arreglos() {
        let md = "## Arreglos\n- a\n## Nuevo\n- b\n### Mejoras:\n- c";
        assert_eq!(agrupar_notas(Some(md)), vec![g("nuevo", "Nuevo", &["b"]), g("mejoras", "Mejoras", &["c"]), g("arreglos", "Arreglos", &["a"])]);
    }

    #[test]
    fn reconoce_encabezados_con_acentos_emojis_y_sinonimos() {
        let r = agrupar_notas(Some("## 🚀 Novedades\n* x\n## Corrección\n1. y\n## Fixes\n+ z"));
        assert_eq!(ids(&r), ["nuevo", "arreglos"]);
        assert_eq!(r[1].items, ["y", "z"]);
    }

    #[test]
    fn un_encabezado_desconocido_conserva_su_texto_como_grupo_propio_despues_de_los_fijos() {
        let r = agrupar_notas(Some("## Seguridad\n- s\n## Nuevo\n- n"));
        assert_eq!(r.iter().map(|x| x.label.as_str()).collect::<Vec<_>>(), ["Nuevo", "Seguridad"]);
    }

    #[test]
    fn vinetas_sin_encabezado_van_a_novedades() {
        assert_eq!(agrupar_notas(Some("- uno\n- dos")), vec![g("otros", "Novedades", &["uno", "dos"])]);
    }

    #[test]
    fn sin_vinetas_el_texto_suelto_son_las_novedades_y_se_ignoran_los_separadores() {
        assert_eq!(agrupar_notas(Some("Hola\n---\nChau"))[0].items, ["Hola", "Chau"]);
    }

    #[test]
    fn con_vinetas_el_texto_suelto_se_descarta() {
        assert_eq!(agrupar_notas(Some("intro\n- a"))[0].items, ["a"]);
    }

    #[test]
    fn entradas_vacias_o_no_texto_dan_lista_vacia() {
        for md in [Some(""), None, Some("   \n\n  "), Some("## Nuevo")] {
            assert_eq!(agrupar_notas(md), vec![], "{md:?}");
        }
    }

    #[test]
    fn acepta_saltos_de_linea_crlf() {
        assert_eq!(agrupar_notas(Some("## Nuevo\r\n- a\r\n- b\r\n"))[0].items, ["a", "b"]);
    }

    #[test]
    fn limita_a_60_items_por_grupo_y_300_caracteres_por_item() {
        let md: Vec<String> = (0..100).map(|i| format!("- item {i}")).collect();
        assert_eq!(agrupar_notas(Some(&md.join("\n")))[0].items.len(), 60);
        assert_eq!(agrupar_notas(Some(&format!("- {}", "x".repeat(5000))))[0].items[0].chars().count(), 300);
    }

    #[test]
    fn una_entrada_enorme_no_se_cuelga() {
        let md = format!("## Nuevo\n{}", "- a [b](c) `d` **e**\n".repeat(20000));
        assert_eq!(agrupar_notas(Some(&md))[0].items.len(), 60);
    }

    #[test]
    fn ignora_vinetas_que_quedan_vacias_tras_limpiar_el_markdown() {
        assert_eq!(agrupar_notas(Some("- <br>\n- ![img](x)")), vec![]);
    }

    #[test]
    fn plain_quita_markdown_en_linea_y_el_sufijo_de_autor_de_github() {
        assert_eq!(plain("Arregla **algo** con `code` y [link](http://x) by @tomy in https://github.com/a/pull/1"), "Arregla algo con code y link");
        assert_eq!(plain("<b>hola</b>   mundo"), "hola mundo");
    }
}
