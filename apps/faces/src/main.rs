//! Local face detection for CupCat — YuNet (OpenCV Zoo, MIT) on ONNX Runtime.
//!
//! Reads image files, prints one JSON line per image with the faces found, as fractions of the
//! image. Runs offline in about a millisecond per frame, which is what lets face blur look at EVERY
//! sampled frame instead of one a second and interpolating between — the interpolation was where
//! tracking drifted away from the face.
//!
//! It deliberately links against the onnxruntime the app already ships (via ORT_DYLIB_PATH), so the
//! whole feature costs one 230 KB model file in the installer.
//!
//! Usage:  cupcat-faces --model yunet.onnx [--threshold 0.6] <image>...
//! Output: {"file":"...","w":1280,"h":720,"faces":[{"x":0.1,"y":0.2,"w":0.1,"h":0.15,"score":0.93}]}

use std::error::Error;

use image::imageops::FilterType;
use ort::session::Session;
use ort::value::Tensor;

/// YuNet 2023mar takes a fixed 640x640 input and predicts on three strides.
const SIZE: usize = 640;
const STRIDES: [usize; 3] = [8, 16, 32];

#[derive(Clone, Copy)]
struct Face {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    score: f32,
}

/// Fit the image inside SIZExSIZE keeping its aspect, padding the remainder.
///
/// Stretching to square would squash a 9:16 phone frame to 1:1 and distort every face on it, which
/// costs real detections. Returns the CHW float tensor plus the scale and offsets needed to map
/// boxes back to the original pixels.
fn letterbox(img: &image::RgbImage) -> (Vec<f32>, f32, f32, f32) {
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    let scale = (SIZE as f32 / iw).min(SIZE as f32 / ih);
    let (nw, nh) = ((iw * scale).round() as u32, (ih * scale).round() as u32);
    let resized = image::imageops::resize(img, nw.max(1), nh.max(1), FilterType::Triangle);
    let dx = ((SIZE as u32 - nw.max(1)) / 2) as f32;
    let dy = ((SIZE as u32 - nh.max(1)) / 2) as f32;

    // CHW, BGR, 0-255 — the layout and channel order YuNet was trained with. Padding is mid-grey so
    // the border doesn't read as a hard edge.
    let mut buf = vec![114.0f32; 3 * SIZE * SIZE];
    for (x, y, px) in resized.enumerate_pixels() {
        let cx = x as usize + dx as usize;
        let cy = y as usize + dy as usize;
        if cx >= SIZE || cy >= SIZE {
            continue;
        }
        let i = cy * SIZE + cx;
        buf[i] = px[2] as f32; // B
        buf[SIZE * SIZE + i] = px[1] as f32; // G
        buf[2 * SIZE * SIZE + i] = px[0] as f32; // R
    }
    (buf, scale, dx, dy)
}

/// Intersection over union, for suppressing duplicate detections of the same face.
fn iou(a: &Face, b: &Face) -> f32 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.w).min(b.x + b.w);
    let y2 = (a.y + a.h).min(b.y + b.h);
    let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    if inter <= 0.0 {
        return 0.0;
    }
    inter / (a.w * a.h + b.w * b.h - inter)
}

/// Keep the strongest box of each overlapping cluster.
fn nms(mut faces: Vec<Face>, thresh: f32) -> Vec<Face> {
    faces.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Face> = Vec::new();
    for f in faces {
        if kept.iter().all(|k| iou(k, &f) < thresh) {
            kept.push(f);
        }
    }
    kept
}

fn detect(session: &mut Session, img: &image::RgbImage, threshold: f32) -> Result<Vec<Face>, Box<dyn Error>> {
    let (buf, scale, dx, dy) = letterbox(img);
    let input = Tensor::from_array(([1usize, 3, SIZE, SIZE], buf))?;
    let outputs = session.run(ort::inputs!["input" => input])?;

    let mut found: Vec<Face> = Vec::new();
    for stride in STRIDES {
        let cols = SIZE / stride; // feature-map width == height
        let cls = outputs[format!("cls_{stride}").as_str()].try_extract_tensor::<f32>()?.1;
        let obj = outputs[format!("obj_{stride}").as_str()].try_extract_tensor::<f32>()?.1;
        let bbox = outputs[format!("bbox_{stride}").as_str()].try_extract_tensor::<f32>()?.1;

        for idx in 0..(cols * cols) {
            // Two heads vote; the geometric mean is what the reference implementation scores with.
            let score = (cls[idx].clamp(0.0, 1.0) * obj[idx].clamp(0.0, 1.0)).sqrt();
            if score < threshold {
                continue;
            }
            let (col, row) = (idx % cols, idx / cols);
            let b = &bbox[idx * 4..idx * 4 + 4];
            // Centre is an offset from the cell; size is log-encoded. Both in units of the stride.
            let cx = (col as f32 + b[0]) * stride as f32;
            let cy = (row as f32 + b[1]) * stride as f32;
            let w = b[2].exp() * stride as f32;
            let h = b[3].exp() * stride as f32;
            // Undo the letterbox: drop the padding, then back to source pixels.
            found.push(Face {
                x: (cx - w / 2.0 - dx) / scale,
                y: (cy - h / 2.0 - dy) / scale,
                w: w / scale,
                h: h / scale,
                score,
            });
        }
    }
    Ok(nms(found, 0.3))
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut model = String::new();
    let mut threshold = 0.6f32;
    let mut files: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--model" => model = args.next().unwrap_or_default(),
            "--threshold" => threshold = args.next().and_then(|v| v.parse().ok()).unwrap_or(0.6),
            other => files.push(other.to_string()),
        }
    }
    if model.is_empty() || files.is_empty() {
        eprintln!("usage: cupcat-faces --model <yunet.onnx> [--threshold 0.6] <image>...");
        std::process::exit(2);
    }

    let mut session = Session::builder()?.commit_from_file(&model)?;

    for f in files {
        // One unreadable frame must not sink the batch: report it empty and carry on.
        let img = match image::open(&f) {
            Ok(i) => i.to_rgb8(),
            Err(_) => {
                println!("{{\"file\":{},\"w\":0,\"h\":0,\"faces\":[]}}", json_str(&f));
                continue;
            }
        };
        let (iw, ih) = (img.width() as f32, img.height() as f32);
        let faces = detect(&mut session, &img, threshold).unwrap_or_default();
        let items: Vec<String> = faces
            .iter()
            .map(|d| {
                // Clamp to the frame and emit fractions — the bridge works in fractions so the same
                // numbers survive any later resize.
                let x = (d.x / iw).clamp(0.0, 1.0);
                let y = (d.y / ih).clamp(0.0, 1.0);
                let w = (d.w / iw).clamp(0.0, 1.0 - x);
                let h = (d.h / ih).clamp(0.0, 1.0 - y);
                format!(
                    "{{\"x\":{x:.5},\"y\":{y:.5},\"w\":{w:.5},\"h\":{h:.5},\"score\":{:.3}}}",
                    d.score
                )
            })
            .collect();
        println!(
            "{{\"file\":{},\"w\":{},\"h\":{},\"faces\":[{}]}}",
            json_str(&f),
            iw as u32,
            ih as u32,
            items.join(",")
        );
    }
    Ok(())
}

/// Minimal JSON string escaping — Windows paths are full of backslashes.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
