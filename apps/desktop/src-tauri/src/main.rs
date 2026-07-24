// CupCat desktop shell: launches the compiled bridge as a sidecar (MCP + WebSocket + media on
// 127.0.0.1:19789) and shows the bundled SPA, which talks to the bridge over that port.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running bridge sidecar so it can be killed on app exit. The bridge is a standalone
/// server process (its own event loop) that never exits on its own — without this, closing the
/// CupCat window left it running invisibly in the background. Across runs those zombies pile up,
/// fight over the port, and even lock cupcat-bridge.exe so a reinstall/update fails to overwrite it.
struct BridgeProcess(Mutex<Option<CommandChild>>);

/// Build the bridge sidecar command with every env var it needs, pointing it at the bundled tools.
/// A function (not inline) so the SUPERVISOR can respawn it: the bridge dying used to leave the
/// window alive with no engine and no way back — Try again only reconnected to a process that was
/// gone, and Reload only refreshed the page. Now every death is followed by a fresh spawn.
fn build_sidecar(app: &tauri::AppHandle) -> Result<tauri_plugin_shell::process::Command, Box<dyn std::error::Error>> {
    let sidecars = app.path().resource_dir()?.join("sidecars");
    let p = |name: &str| sidecars.join(name).to_string_lossy().into_owned();
    Ok(app
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
        // Speaker diarization (sherpa-onnx): the CLI exe, its DLLs, and the segmentation +
        // embedding .onnx models the bridge scans for.
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
        // Local face detection (YuNet on ONNX Runtime), linked against diarization's onnxruntime.
        .env("CUPCAT_FACES_BIN", p("faces/cupcat-faces.exe"))
        .env("CUPCAT_FACES_MODEL", p("faces/yunet.onnx"))
        .env("ORT_DYLIB_PATH", p("diarize/onnxruntime.dll"))
        .env("CUPCAT_VERSION", app.package_info().version.to_string()))
}

/// Keep the bridge alive for as long as the app is open. Spawns it, streams its output to the
/// console and to a persistent log file (so a crash is diagnosable after the fact), and when it
/// exits — for any reason other than the app itself shutting down — waits briefly and respawns.
///
/// This is the fix for "the engine is gone and nothing brings it back": the previous shell spawned
/// the bridge once and, when it died, simply stopped reading its events. Restart is backed off so a
/// bridge that dies instantly on boot can't spin the CPU, and capped so a permanently broken build
/// eventually gives up rather than looping forever.
async fn supervise(app: tauri::AppHandle, shutting_down: Arc<AtomicBool>, log_path: Option<PathBuf>) {
    use std::io::Write;
    let mut fails: u32 = 0;
    loop {
        if shutting_down.load(Ordering::SeqCst) {
            break;
        }
        let cmd = match build_sidecar(&app) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[cupcat] cannot prepare the engine: {e}");
                break;
            }
        };
        let (mut rx, child) = match cmd.spawn() {
            Ok(x) => x,
            Err(e) => {
                eprintln!("[cupcat] cannot start the engine: {e}");
                fails += 1;
                if fails > 20 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(std::cmp::min(1000 * fails as u64, 5000))).await;
                continue;
            }
        };
        if let Some(state) = app.try_state::<BridgeProcess>() {
            *state.0.lock().unwrap() = Some(child);
        }
        let started = std::time::Instant::now();
        // Drain the process's output until the channel closes, which happens when it exits.
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let s = String::from_utf8_lossy(&line);
                    print!("[bridge] {s}");
                    if let Some(ref lp) = log_path {
                        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(lp) {
                            let _ = f.write_all(s.as_bytes());
                        }
                    }
                }
                _ => {}
            }
        }
        if shutting_down.load(Ordering::SeqCst) {
            break;
        }
        // Ran for a good while before dying → a genuine crash, not a boot loop: forgive past failures.
        if started.elapsed().as_secs() > 20 {
            fails = 0;
        }
        fails += 1;
        if fails > 20 {
            eprintln!("[cupcat] the engine keeps stopping; giving up restarting it");
            break;
        }
        let wait = std::cmp::min(1000 * fails as u64, 5000);
        eprintln!("[cupcat] engine stopped; restarting in {wait}ms");
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
        // Tell the UI the engine bounced so it reconnects immediately rather than waiting out its
        // own retry timer.
        let _ = app.emit("bridge-restarted", ());
    }
}

/// Truncate the bridge log if it has grown large, so it never fills the disk over a long life.
fn prepare_log(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("bridge.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    Some(path)
}

fn main() {
    // Let the preview's <audio>/<video> elements play without a per-element user gesture — otherwise
    // WebView2 blocks unmuted audio playback and the timeline preview is silent.
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--autoplay-policy=no-user-gesture-required",
    );

    let shutting_down = Arc::new(AtomicBool::new(false));
    let sd_setup = shutting_down.clone();
    let sd_run = shutting_down.clone();

    tauri::Builder::default()
        // Single instance FIRST: a second launch must not open a second window with its own bridge
        // fighting for the port. It focuses the window already open instead — which is the clean fix
        // for the whole "second window borrows the first's engine, then loses it" failure.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BridgeProcess(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let log_path = prepare_log(&handle);
            let sd = sd_setup.clone();
            tauri::async_runtime::spawn(async move {
                supervise(handle, sd, log_path).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CupCat")
        .run(move |app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                // Tell the supervisor to stop respawning, then kill the current bridge.
                sd_run.store(true, Ordering::SeqCst);
                if let Some(state) = app_handle.try_state::<BridgeProcess>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
