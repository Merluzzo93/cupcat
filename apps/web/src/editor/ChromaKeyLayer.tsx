// Live chroma-key preview: a WebGL2 canvas that redraws the clip's <video> every animation frame
// through a keying shader, so a green-screen clip is actually transparent on the canvas instead of
// staying export-only. The math mirrors ffmpeg's `chromakey` filter: the pixel↔key distance is
// measured in the UV (chroma) plane — luma is ignored, so shadows/highlights on the screen still
// key out — and alpha = smoothstep(similarity, similarity+blend, distance).
//
// Node/pipeline sketch:
//   <video> (hidden, still the decoding source)
//     └─ texImage2D each rAF → fullscreen quad → fragment shader:
//          uv(pixel) vs uv(keyColor) → d = distance*2 (≈ ffmpeg's normalized diff)
//          alpha = smoothstep(similarity, similarity+blend, d)
//   canvas context: webgl2, premultipliedAlpha:false → browser composites straight alpha.

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

let webgl2: boolean | null = null;
/** One-time capability probe. When false the caller keeps the plain <video> (chromakey then stays
 * export-only and the canvas badge says so). */
export function hasWebGL2(): boolean {
  if (webgl2 === null) {
    try {
      webgl2 = typeof document !== "undefined" && !!document.createElement("canvas").getContext("webgl2");
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

/** "#00ff00" / "0x00ff00" / "00ff00" → [r,g,b] in 0..1 (ffmpeg and CSS spellings both appear). */
export function parseKeyColor(hex: string): [number, number, number] {
  const m = /^(?:#|0x)?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [0, 1, 0]; // default green screen
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // Fullscreen triangle-strip quad from gl_VertexID — no vertex buffers needed.
  vec2 pos = vec2((gl_VertexID & 1) == 1 ? 1.0 : -1.0, (gl_VertexID & 2) == 2 ? 1.0 : -1.0);
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec3 u_key;
uniform float u_similarity;
uniform float u_blend;
in vec2 v_uv;
out vec4 outColor;
// BT.601-style chroma projection (same family ffmpeg's chromakey uses internally).
vec2 chroma(vec3 c) {
  return vec2(c.r * -0.169 - c.g * 0.331 + c.b * 0.5, c.r * 0.5 - c.g * 0.419 - c.b * 0.081);
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  // ×2 rescales the UV-plane distance toward ffmpeg's normalized diff so the same
  // similarity/blend numbers look comparable in preview and export.
  float d = distance(chroma(c.rgb), chroma(u_key)) * 2.0;
  float a = smoothstep(u_similarity, u_similarity + max(u_blend, 0.0001), d);
  outColor = vec4(c.rgb, c.a * a);
}`;

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

/** The keyed stand-in for a chroma clip's <video>. The video element (passed in, kept hidden by
 * the caller) stays the decoding source; this canvas is what the user sees. */
export function ChromaKeyCanvas({
  video,
  style,
  colorHex,
  similarity,
  blend,
}: {
  video: HTMLVideoElement | null;
  style: CSSProperties;
  colorHex: string;
  similarity: number;
  blend: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !video) return;
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", { premultipliedAlpha: false });
    } catch {
      gl = null;
    }
    if (!gl) return; // capability probe said yes but the context still failed — leave the canvas blank
    const prog = buildProgram(gl);
    if (!prog) return;
    gl.useProgram(prog);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // video rows are top-down, GL's are bottom-up
    const [r, g, b] = parseKeyColor(colorHex);
    gl.uniform3f(gl.getUniformLocation(prog, "u_key"), r, g, b);
    gl.uniform1f(gl.getUniformLocation(prog, "u_similarity"), similarity);
    gl.uniform1f(gl.getUniformLocation(prog, "u_blend"), blend);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!gl || video.readyState < 2) return; // nothing decoded yet
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch {
        return; // e.g. a tainted/cross-origin frame — skip, retry next frame
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      gl?.getExtension("WEBGL_lose_context")?.loseContext(); // free the GPU context promptly
    };
  }, [video, colorHex, similarity, blend]);

  // pointer-events none: click-to-select on the canvas keeps hitting the layer beneath.
  return <canvas ref={canvasRef} className="object-cover" style={{ ...style, pointerEvents: "none" }} />;
}
