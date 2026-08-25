/* _webgl-live.js — run CYT's EXACT extraction inside our real page env and
 * compare hashes with/without our hooks. Reveals if the farble fires. */
'use strict';
const { app } = require('electron');
const path = require('path');

process.env.FORGE_DEBUG_CONSOLE = '1';
require(path.join(__dirname, '..', 'src', 'main.js'));

setTimeout(async () => {
  try {
    const { BrowserWindow, webContents } = require('electron');
    const chromeWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!chromeWin) { console.log('NO CHROME WIN'); app.exit(1); return; }
    await chromeWin.webContents.executeJavaScript(`window.forge.navigate('https://coveryourtracks.eff.org/')`);
    await new Promise((r) => setTimeout(r, 8000));
    const page = webContents.getAllWebContents().find((wc) => (wc.getURL() || '').includes('coveryourtracks'));
    if (!page) { console.log('PAGE NOT FOUND'); app.exit(1); return; }

    const probe = await page.executeJavaScript(`(() => {
      function webglHash() {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl');
        if (!gl) return 'no-webgl';
        // draw something deterministic
        const vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p,0,1); }';
        const fs = 'void main(){ gl_FragColor = vec4(0.5,0.8,0.3,1); }';
        const s = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(s, vs); gl.compileShader(s);
        const f = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(f, fs); gl.compileShader(f);
        const pr = gl.createProgram(); gl.attachShader(pr, s); gl.attachShader(pr, f); gl.linkProgram(pr); gl.useProgram(pr);
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 0,1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // extract via readPixels
        const px = new Uint8Array(4 * 300 * 150);
        gl.readPixels(0, 0, 300, 150, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let h1 = 0;
        for (let i = 0; i < px.length; i += 97) { h1 = ((h1 << 5) - h1 + px[i]) | 0; }
        // extract via toDataURL
        const url = c.toDataURL();
        let h2 = 0;
        for (let i = 0; i < url.length; i += 131) { h2 = ((h2 << 5) - h2 + url.charCodeAt(i)) | 0; }
        return 'readPixels:' + (h1 >>> 0).toString(16) + ' | toDataURL:' + (h2 >>> 0).toString(16);
      }
      return { hash1: webglHash(), hash2: webglHash(), hash3: webglHash() };
    })()`);
    console.log('WEBGL HASHES (should differ per call if farbling works):');
    console.log(probe.hash1);
    console.log(probe.hash2);
    console.log(probe.hash3);
    const same = probe.hash1 === probe.hash2 && probe.hash2 === probe.hash3;
    console.log(same ? 'RESULT: IDENTICAL — farbling NOT firing' : 'RESULT: DIFFERENT — farbling WORKS');
  } catch (e) { console.log('ERR', String(e).slice(0, 200)); }
  app.exit(0);
}, 7000);