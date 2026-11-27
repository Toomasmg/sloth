//! Permisos de WebView2. Sloth solo pide el micrófono (dictado): se concede sin preguntar, porque la página
//! es la propia interfaz empaquetada. Todo lo demás (cámara, ubicación, etc.) queda en el valor por defecto
//! del webview, que pregunta o niega. Es lo que antes hacía `session.setPermissionRequestHandler` en Electron.
use tauri::{AppHandle, Manager};

#[cfg(windows)]
pub fn conceder_microfono(app: &AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW};
    use webview2_com::PermissionRequestedEventHandler;

    let Some(ventana) = app.get_webview_window("main") else { return };
    let _ = ventana.with_webview(|wv| {
        // SAFETY: llamadas COM sobre el controlador vivo de la ventana, desde el hilo de la interfaz.
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let mut token = std::mem::zeroed();
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        let mut tipo = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut tipo)?;
                        if tipo == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    });
}

#[cfg(not(windows))]
pub fn conceder_microfono(_app: &AppHandle) {}
