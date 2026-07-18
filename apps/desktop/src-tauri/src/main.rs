// CupCat desktop shell: launches the compiled bridge as a sidecar (MCP + WebSocket + media on
// 127.0.0.1:19789) and shows the bundled SPA, which talks to the bridge over that port.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running bridge sidecar so it can be killed on app exit. The bridge is a standalone
/// server process (its own event loop) that never exits on its own — without this, closing the
/// CupCat window left it running invisibly in the background. Across runs those zombies pile up,
/// fight over the port, and even lock cupcat-bridge.exe so a reinstall/update fails to overwrite it.
struct BridgeProcess(Mutex<Option<CommandChild>>);

fn main() {
    // Let the preview's <audio>/<video> elements play without a per-element user gesture — otherwise
    // WebView2 blocks unmuted audio playback and the timeline preview is silent.
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--autoplay-policy=no-user-gesture-required",
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Spawn the self-contained bridge. Its sidecars (ffmpeg/higgsfield/whisper) are
            // resolved from the app's resource dir via env in a later step.
            // Point the bridge at the bundled sidecars so generation/export work with nothing preinstalled.
            let sidecars = app.path().resource_dir()?.join("sidecars");
            let p = |name: &str| sidecars.join(name).to_string_lossy().into_owned();
            let sidecar = app
                .shell()
                .sidecar("cupcat-bridge")?
                .env("CUPCAT_FFMPEG_BIN", p("ffmpeg.exe"))
                .env("CUPCAT_FFPROBE_BIN", p("ffprobe.exe"))
                .env("CUPCAT_HIGGSFIELD_BIN", p("higgsfield.exe"))
                .env("CUPCAT_WHISPER_KIND", "cpp")
                .env("CUPCAT_WHISPER_BIN", p("whisper-cli.exe"))
                .env("CUPCAT_WHISPER_MODEL_FILE", p("ggml-large-v3-turbo-q5.bin"))
                .env("CUPCAT_YTDLP_BIN", p("yt-dlp.exe"))
                // Piper TTS lives in its own subfolder: piper.exe + espeak-ng data + the .onnx
                // voices, which double as the voices dir the bridge scans for 'it'/'en'.
                .env("CUPCAT_PIPER_BIN", p("piper/piper.exe"))
                .env("CUPCAT_PIPER_VOICES_DIR", p("piper"))
                // Speaker diarization (sherpa-onnx) also lives in its own subfolder: the CLI exe,
                // its DLLs, and the segmentation + embedding .onnx models the bridge scans for.
                .env(
                    "CUPCAT_DIARIZE_BIN",
                    p("diarize/sherpa-onnx-offline-speaker-diarization.exe"),
                )
                .env("CUPCAT_DIARIZE_DIR", p("diarize"))
                // Local source separation (sherpa-onnx spleeter): its own CLI exe + DLLs + the
                // vocals/accompaniment .onnx models, in sidecars/separate.
                .env(
                    "CUPCAT_SEPARATE_BIN",
                    p("separate/sherpa-onnx-offline-source-separation.exe"),
                )
                .env("CUPCAT_SEPARATE_DIR", p("separate"))
                .env("CUPCAT_VERSION", app.package_info().version.to_string());
            let (mut rx, child) = sidecar.spawn()?;
            app.manage(BridgeProcess(Mutex::new(Some(child))));
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            print!("[bridge] {}", String::from_utf8_lossy(&line));
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CupCat")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BridgeProcess>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
