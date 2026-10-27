#!/usr/bin/env python3
"""Rasteriza las caras SVG a PNG para poder revisarlas sin navegador.

No es un renderizador general: entiende solo las primitivas que usa faces.js
(circle, ellipse, rect, line, path con M/L/Q/Z, translate y degradado radial).
Sirve para comprobar el resultado visual durante el desarrollo.
"""
import math
import re
import struct
import subprocess
import sys
import zlib
import xml.etree.ElementTree as ET

SS = 2  # supermuestreo para suavizar bordes
NS = '{http://www.w3.org/2000/svg}'


# ----------------------------------------------------------------- color

def parse_color(c, opacity=1.0):
    if c is None or c == 'none':
        return None
    c = c.strip()
    if c.startswith('url('):
        return 'GRAD'
    if c.startswith('#'):
        if len(c) == 4:
            c = '#' + ''.join(ch * 2 for ch in c[1:])
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), opacity)
    m = re.match(r'hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)', c)
    if m:
        h, s, light = float(m.group(1)) / 360, float(m.group(2)) / 100, float(m.group(3)) / 100
        import colorsys
        r, g, b = colorsys.hls_to_rgb(h, light, s)
        return (round(r * 255), round(g * 255), round(b * 255), opacity)
    m = re.match(r'rgba?\(([^)]+)\)', c)
    if m:
        p = [x.strip() for x in m.group(1).split(',')]
        a = float(p[3]) if len(p) > 3 else 1.0
        return (int(p[0]), int(p[1]), int(p[2]), a * opacity)
    return {'white': (255, 255, 255, opacity), '#fff': (255, 255, 255, opacity)}.get(c.lower(), (0, 0, 0, opacity))


# ----------------------------------------------------------------- geometria

def flatten_path(d, pasos=14):
    """Convierte el atributo d en una lista de sub-poligonos."""
    tokens = re.findall(r'([MLQZmlqz])|(-?[\d.]+)', d)
    subs, cur, pos, i = [], [], (0.0, 0.0), 0
    vals, cmd = [], None
    seq = []
    for letra, num in tokens:
        if letra:
            if cmd:
                seq.append((cmd, vals))
            cmd, vals = letra, []
        else:
            vals.append(float(num))
    if cmd:
        seq.append((cmd, vals))

    for c, v in seq:
        if c in 'Mm':
            if cur:
                subs.append(cur)
            pos = (v[0], v[1])
            cur = [pos]
        elif c in 'Ll':
            for k in range(0, len(v), 2):
                pos = (v[k], v[k + 1])
                cur.append(pos)
        elif c in 'Qq':
            for k in range(0, len(v), 4):
                x1, y1, x2, y2 = v[k:k + 4]
                x0, y0 = pos
                for t in range(1, pasos + 1):
                    t /= pasos
                    mt = 1 - t
                    cur.append((mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
                                mt * mt * y0 + 2 * mt * t * y1 + t * t * y2))
                pos = (x2, y2)
        elif c in 'Zz':
            if cur:
                cur.append(cur[0])
                subs.append(cur)
                cur = []
    if cur:
        subs.append(cur)
    return subs


def dist_seg(px, py, x1, y1, x2, y2):
    vx, vy = x2 - x1, y2 - y1
    l2 = vx * vx + vy * vy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / l2))
    return math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))


def dentro(px, py, subs):
    dentro_ = False
    for poly in subs:
        for i in range(len(poly) - 1):
            x1, y1 = poly[i]
            x2, y2 = poly[i + 1]
            if (y1 > py) != (y2 > py):
                xint = x1 + (py - y1) / (y2 - y1) * (x2 - x1)
                if px < xint:
                    dentro_ = not dentro_
    return dentro_


# ----------------------------------------------------------------- escena

def recolectar(nodo, dx, dy, ops, grad):
    for hijo in nodo:
        tag = hijo.tag.replace(NS, '')
        tr = hijo.get('transform', '')
        ndx, ndy = dx, dy
        m = re.match(r'translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)', tr)
        if m:
            ndx += float(m.group(1))
            ndy += float(m.group(2))

        op = float(hijo.get('opacity', 1))
        fill = parse_color(hijo.get('fill'), op)
        stroke = parse_color(hijo.get('stroke'), op)
        sw = float(hijo.get('stroke-width', 1))

        if tag in ('g', 'defs'):
            recolectar(hijo, ndx, ndy, ops, grad)
        elif tag == 'circle':
            cx, cy = float(hijo.get('cx', 0)) + ndx, float(hijo.get('cy', 0)) + ndy
            r = float(hijo.get('r'))
            if fill:
                ops.append(('circle-f', cx, cy, r, fill))
            if stroke:
                ops.append(('ring', cx, cy, r, sw, stroke))
        elif tag == 'ellipse':
            cx, cy = float(hijo.get('cx', 0)) + ndx, float(hijo.get('cy', 0)) + ndy
            rx, ry = float(hijo.get('rx')), float(hijo.get('ry'))
            if fill:
                ops.append(('ellipse-f', cx, cy, rx, ry, fill))
        elif tag == 'rect':
            x, y = float(hijo.get('x')) + ndx, float(hijo.get('y')) + ndy
            w, h = float(hijo.get('width')), float(hijo.get('height'))
            rr = float(hijo.get('rx', 0))
            if fill:
                ops.append(('rect-f', x, y, w, h, rr, fill))
        elif tag == 'line':
            pts = [(float(hijo.get('x1')) + ndx, float(hijo.get('y1')) + ndy),
                   (float(hijo.get('x2')) + ndx, float(hijo.get('y2')) + ndy)]
            if stroke:
                ops.append(('stroke', [pts], sw, stroke))
        elif tag == 'path':
            subs = [[(x + ndx, y + ndy) for (x, y) in s] for s in flatten_path(hijo.get('d'))]
            if fill:
                ops.append(('fill', subs, fill))
            if stroke:
                ops.append(('stroke', subs, sw, stroke))
        elif tag == 'radialGradient':
            paradas = [parse_color(s.get('stop-color')) for s in hijo]
            grad['c'] = paradas


def render(svg_texto, px=160):
    root = ET.fromstring(svg_texto)
    vb = [float(x) for x in root.get('viewBox').split()]
    ops, grad = [], {}
    recolectar(root, 0, 0, ops, grad)

    W = H = px * SS
    escala = W / vb[2]
    buf = bytearray()
    g0 = grad.get('c', [(120, 120, 120, 1)])[0]
    g1 = grad.get('c', [(120, 120, 120, 1), (80, 80, 80, 1)])[-1]

    filas = []
    for yy in range(H):
        fila = bytearray()
        for xx in range(W):
            ux = vb[0] + (xx + 0.5) / escala
            uy = vb[1] + (yy + 0.5) / escala
            col = (15, 17, 21)
            alpha_total = 0.0

            for o in ops:
                k = o[0]
                a, c = 0.0, None
                if k == 'circle-f':
                    _, cx, cy, r, c = o
                    d = math.hypot(ux - cx, uy - cy)
                    a = max(0.0, min(1.0, (r - d) * escala + 0.5))
                elif k == 'ring':
                    _, cx, cy, r, sw, c = o
                    d = abs(math.hypot(ux - cx, uy - cy) - r)
                    a = max(0.0, min(1.0, (sw / 2 - d) * escala + 0.5))
                elif k == 'ellipse-f':
                    _, cx, cy, rx, ry, c = o
                    v = ((ux - cx) / rx) ** 2 + ((uy - cy) / ry) ** 2
                    a = 1.0 if v <= 1 else max(0.0, 1 - (v - 1) * 8)
                elif k == 'rect-f':
                    _, x, y, w, h, rr, c = o
                    cx = min(max(ux, x + rr), x + w - rr)
                    cy = min(max(uy, y + rr), y + h - rr)
                    d = math.hypot(ux - cx, uy - cy)
                    dentro_rect = x <= ux <= x + w and y <= uy <= y + h
                    a = 1.0 if (dentro_rect and d <= rr + 0.01) else 0.0
                elif k == 'fill':
                    _, subs, c = o
                    a = 1.0 if dentro(ux, uy, subs) else 0.0
                elif k == 'stroke':
                    _, subs, sw, c = o
                    dmin = 1e9
                    for poly in subs:
                        for i in range(len(poly) - 1):
                            dmin = min(dmin, dist_seg(ux, uy, *poly[i], *poly[i + 1]))
                    a = max(0.0, min(1.0, (sw / 2 - dmin) * escala + 0.5))

                if a <= 0 or c is None:
                    continue
                if c == 'GRAD':
                    t = min(1.0, math.hypot(ux + 16, uy + 20) / 70)
                    c = tuple(round(g0[i] + (g1[i] - g0[i]) * t) for i in range(3)) + (1.0,)
                a *= c[3]
                col = tuple(round(col[i] + (c[i] - col[i]) * a) for i in range(3))
                alpha_total = alpha_total + a * (1 - alpha_total)

            fila += bytes((*col, round(255 * min(1.0, alpha_total))))
        filas.append(bytes(fila))

    # reduccion del supermuestreo
    out = []
    for y in range(px):
        fila = bytearray()
        for x in range(px):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                for dx in range(SS):
                    o = ((y * SS + dy) * W + (x * SS + dx)) * 4
                    src = filas[y * SS + dy]
                    base = (x * SS + dx) * 4
                    for i in range(4):
                        acc[i] += src[base + i]
            fila += bytes(v // (SS * SS) for v in acc)
        out.append(bytes(fila))
    return px, out


def guardar(nombre, size, filas):
    raw = b''.join(b'\x00' + f for f in filas)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(nombre, 'wb').write(png)


if __name__ == '__main__':
    semillas = sys.argv[1:] or ['Telefonia', 'Base de Datos', 'Usuarios', 'Panel']
    for i, s in enumerate(semillas):
        svg = subprocess.run(
            ['node', '-e', 'global.window={};require("/opt/codex-web-v4/public/faces.js");'
                           'process.stdout.write(window.caraSvg(process.argv[1],"idle",160))', s],
            capture_output=True, text=True).stdout
        size, filas = render(svg)
        guardar(f'/tmp/cara-{i}.png', size, filas)
        print(f'/tmp/cara-{i}.png  ←  {s}')
