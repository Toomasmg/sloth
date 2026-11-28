//! Lo de Windows que Tauri no trae: el diálogo con botones propios y casilla («No volver a preguntar») de
//! `showMessageBox`, y el punto de la barra de tareas (`setOverlayIcon`). Electron usa las mismas APIs.
use sloth_core::features::tray::{Dialogo, RespuestaDialogo, TipoDialogo};
use std::ffi::c_void;

fn ancho(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Diálogo de tareas de comctl32 v6. `None` si no está disponible (sin el manifiesto de controles comunes v6, como en
/// los binarios de prueba): quien llama usa el diálogo simple de Tauri.
#[cfg(windows)]
pub fn dialogo(ventana: *mut c_void, d: &Dialogo) -> Option<RespuestaDialogo> {
    use windows_sys::core::{s, w, HRESULT};
    use windows_sys::Win32::Foundation::{BOOL, HWND};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOGCONFIG_1, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW,
        TD_INFORMATION_ICON, TD_WARNING_ICON,
    };
    type TaskDialogIndirect = unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;
    const PRIMER_ID: i32 = 100;
    const IDCANCEL: i32 = 2;

    // SAFETY: carga por nombre y la firma es la documentada de TaskDialogIndirect. Con un import estático el binario
    // no arrancaría donde solo está comctl32 v5.
    let funcion: TaskDialogIndirect = unsafe {
        let modulo = LoadLibraryW(w!("comctl32.dll"));
        if modulo.is_null() {
            return None;
        }
        std::mem::transmute(GetProcAddress(modulo, s!("TaskDialogIndirect"))?)
    };
    let titulo = ancho(&d.titulo);
    let mensaje = ancho(&d.mensaje);
    let detalle = ancho(&d.detalle);
    let casilla = d.casilla.as_deref().map(ancho);
    let textos: Vec<Vec<u16>> = d.botones.iter().map(|b| ancho(b)).collect();
    let botones: Vec<TASKDIALOG_BUTTON> = textos.iter().enumerate().map(|(i, t)| TASKDIALOG_BUTTON { nButtonID: PRIMER_ID + i as i32, pszButtonText: t.as_ptr() }).collect();
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: ventana as HWND,
        hInstance: std::ptr::null_mut(),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
        dwCommonButtons: 0,
        pszWindowTitle: titulo.as_ptr(),
        Anonymous1: TASKDIALOGCONFIG_0 { pszMainIcon: if d.tipo == TipoDialogo::Advertencia { TD_WARNING_ICON } else { TD_INFORMATION_ICON } },
        pszMainInstruction: mensaje.as_ptr(),
        pszContent: detalle.as_ptr(),
        cButtons: botones.len() as u32,
        pButtons: botones.as_ptr(),
        nDefaultButton: PRIMER_ID + d.por_defecto as i32,
        cRadioButtons: 0,
        pRadioButtons: std::ptr::null(),
        nDefaultRadioButton: 0,
        pszVerificationText: casilla.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
        pszExpandedInformation: std::ptr::null(),
        pszExpandedControlText: std::ptr::null(),
        pszCollapsedControlText: std::ptr::null(),
        Anonymous2: TASKDIALOGCONFIG_1 { pszFooterIcon: std::ptr::null() },
        pszFooter: std::ptr::null(),
        pfCallback: None,
        lpCallbackData: 0,
        cxWidth: 0,
    };
    let (mut boton, mut marcada): (i32, BOOL) = (0, 0);
    // SAFETY: la configuración y todos los textos y botones a los que apunta viven hasta que vuelve la llamada (modal).
    let hr = unsafe { funcion(&config, &mut boton, std::ptr::null_mut(), &mut marcada) };
    if hr < 0 {
        return None;
    }
    // Escape o la X del diálogo cuentan como el botón de cancelar.
    let elegido = if boton == IDCANCEL { d.cancelar } else { (boton - PRIMER_ID).clamp(0, d.botones.len() as i32 - 1) as usize };
    Some(RespuestaDialogo { boton: elegido, casilla: marcada != 0 })
}

#[cfg(not(windows))]
pub fn dialogo(_: *mut c_void, _: &Dialogo) -> Option<RespuestaDialogo> {
    None
}

/// Pone (o saca, con `None`) el punto ámbar sobre el botón de Sloth en la barra de tareas, con su descripción para el
/// lector de pantalla. Va en el hilo principal: ahí COM ya está iniciado por la ventana.
#[cfg(windows)]
pub fn poner_punto(ventana: *mut c_void, descripcion: Option<&str>) -> Result<(), String> {
    use windows_sys::core::{GUID, HRESULT, PCWSTR};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIcon, DestroyIcon, GetSystemMetrics, HICON, SM_CXSMICON};
    const CLSID_TASKBAR_LIST: GUID = GUID::from_u128(0x56fdf344_fd6d_11d0_958a_006097c9a090);
    const IID_ITASKBAR_LIST3: GUID = GUID::from_u128(0xea1afb91_9e28_4b86_90e9_9e9f8a5eefaf);
    // Posiciones en la tabla de ITaskbarList3: IUnknown (0-2), HrInit (3) ... SetOverlayIcon (18).
    const RELEASE: usize = 2;
    const HR_INIT: usize = 3;
    const SET_OVERLAY_ICON: usize = 18;
    type Metodo = unsafe extern "system" fn(*mut c_void) -> HRESULT;
    type SetOverlayIcon = unsafe extern "system" fn(*mut c_void, HWND, HICON, PCWSTR) -> HRESULT;

    let mut lista: *mut c_void = std::ptr::null_mut();
    // SAFETY: CLSID e IID documentados de la barra de tareas; `lista` queda con una referencia que se suelta al final.
    let hr = unsafe { CoCreateInstance(&CLSID_TASKBAR_LIST, std::ptr::null_mut(), CLSCTX_INPROC_SERVER, &IID_ITASKBAR_LIST3, &mut lista) };
    if hr < 0 || lista.is_null() {
        return Err(format!("no se pudo abrir la barra de tareas (0x{hr:08x})"));
    }
    // SAFETY: `lista` es un ITaskbarList3 válido: su primer campo es la tabla de métodos, en el orden del SDK.
    unsafe {
        let tabla = *(lista as *const *const usize);
        let metodo = |i: usize| *tabla.add(i);
        let resultado = (|| {
            let hr = std::mem::transmute::<usize, Metodo>(metodo(HR_INIT))(lista);
            if hr < 0 {
                return Err(format!("la barra de tareas no respondió (0x{hr:08x})"));
            }
            let poner = std::mem::transmute::<usize, SetOverlayIcon>(metodo(SET_OVERLAY_ICON));
            let Some(texto) = descripcion else {
                poner(lista, ventana as HWND, std::ptr::null_mut(), std::ptr::null());
                return Ok(());
            };
            let tam = GetSystemMetrics(SM_CXSMICON).clamp(16, 32);
            let color = sloth_core::features::tray::punto_ambar(tam as usize);
            // Máscara en cero: la transparencia la da el canal alfa de los 32 bits.
            let mascara = vec![0u8; (tam as usize).div_ceil(16) * 2 * tam as usize];
            let icono = CreateIcon(std::ptr::null_mut(), tam, tam, 1, 32, mascara.as_ptr(), color.as_ptr());
            if icono.is_null() {
                return Err("no se pudo armar el punto de la barra de tareas".into());
            }
            let texto = ancho(texto);
            let hr = poner(lista, ventana as HWND, icono, texto.as_ptr());
            // La barra de tareas se queda con su propia copia del ícono.
            DestroyIcon(icono);
            if hr < 0 {
                return Err(format!("no se pudo poner el punto (0x{hr:08x})"));
            }
            Ok(())
        })();
        std::mem::transmute::<usize, Metodo>(metodo(RELEASE))(lista);
        resultado
    }
}

#[cfg(not(windows))]
pub fn poner_punto(_: *mut c_void, _: Option<&str>) -> Result<(), String> {
    Ok(())
}
