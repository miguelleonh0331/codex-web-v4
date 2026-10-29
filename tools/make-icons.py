#!/usr/bin/env python3
"""Genera los iconos PNG de la PWA sin dependencias externas.

El motivo: tres nodos conectados: los especialistas hablandose entre si.
"""
import math
import struct
import zlib
import os

BG = (15, 17, 21)          # #0f1115
NODE_A = (91, 157, 255)    # azul acento
NODE_B = (43, 212, 160)    # verde
NODE_C = (185, 140, 255)   # violeta (mensajes entre agentes)
LINK = (56, 64, 82)

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')


def mezclar(fondo, color, alpha):
    return tuple(round(f + (c - f) * alpha) for f, c in zip(fondo, color))


def cobertura_circulo(px, py, cx, cy, r):
    """Antialiasing barato: distancia al borde en un margen de 1 px."""
    d = math.hypot(px - cx, py - cy)
    if d <= r - 0.5:
        return 1.0
    if d >= r + 0.5:
        return 0.0
    return r + 0.5 - d


def cobertura_segmento(px, py, x1, y1, x2, y2, grosor):
    vx, vy = x2 - x1, y2 - y1
    largo2 = vx * vx + vy * vy
    t = 0.0 if largo2 == 0 else max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / largo2))
    d = math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))
    r = grosor / 2
    if d <= r - 0.5:
        return 1.0
    if d >= r + 0.5:
        return 0.0
    return r + 0.5 - d


def generar(size, maskable=False):
    # En un icono maskable el sistema recorta hasta un 20% por lado.
    escala = 0.62 if maskable else 0.78
    cx, cy = size / 2, size / 2
    radio_orbita = size * escala * 0.30
    radio_nodo = size * escala * 0.115
    grosor = max(2.0, size * escala * 0.035)

    nodos = []
    for i, color in enumerate((NODE_A, NODE_B, NODE_C)):
        ang = -math.pi / 2 + i * (2 * math.pi / 3)
        nodos.append((cx + radio_orbita * math.cos(ang), cy + radio_orbita * math.sin(ang), color))

    filas = []
    for y in range(size):
        fila = bytearray()
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            color = BG

            # esquinas redondeadas solo en el icono normal
            if not maskable:
                r = size * 0.22
                dx = abs(px - cx) - (size / 2 - r)
                dy = abs(py - cy) - (size / 2 - r)
                if dx > 0 and dy > 0 and math.hypot(dx, dy) > r:
                    fila += bytes((0, 0, 0, 0))
                    continue

            for i in range(3):
                x1, y1, _ = nodos[i]
                x2, y2, _ = nodos[(i + 1) % 3]
                a = cobertura_segmento(px, py, x1, y1, x2, y2, grosor)
                if a > 0:
                    color = mezclar(color, LINK, a)

            for nx, ny, nc in nodos:
                a = cobertura_circulo(px, py, nx, ny, radio_nodo)
                if a > 0:
                    color = mezclar(color, nc, a)

            fila += bytes((*color, 255))
        filas.append(bytes(fila))

    raw = b''.join(b'\x00' + f for f in filas)

    def chunk(tipo, datos):
        c = struct.pack('>I', len(datos)) + tipo + datos
        return c + struct.pack('>I', zlib.crc32(tipo + datos) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    return png


def generar_insignia(size=96):
    """Icono pequeno para la barra de estado de Android.

    Android ignora el color y solo usa el canal alfa, asi que se dibuja en
    blanco sobre transparente. Trazos mas gruesos que en el icono grande:
    a 24 px reales, lo fino desaparece.
    """
    cx, cy = size / 2, size / 2
    radio_orbita = size * 0.30
    radio_nodo = size * 0.115
    grosor = max(3.0, size * 0.055)

    nodos = []
    for i in range(3):
        ang = -math.pi / 2 + i * (2 * math.pi / 3)
        nodos.append((cx + radio_orbita * math.cos(ang), cy + radio_orbita * math.sin(ang)))

    filas = []
    for y in range(size):
        fila = bytearray()
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            a = 0.0
            for i in range(3):
                x1, y1 = nodos[i]
                x2, y2 = nodos[(i + 1) % 3]
                a = max(a, cobertura_segmento(px, py, x1, y1, x2, y2, grosor))
            for nx, ny in nodos:
                a = max(a, cobertura_circulo(px, py, nx, ny, radio_nodo))
            fila += bytes((255, 255, 255, round(max(0.0, min(1.0, a)) * 255)))
        filas.append(bytes(fila))

    raw = b''.join(b'\x00' + f for f in filas)

    def chunk(tipo, datos):
        c = struct.pack('>I', len(datos)) + tipo + datos
        return c + struct.pack('>I', zlib.crc32(tipo + datos) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        with open(os.path.join(OUT, f'icon-{size}.png'), 'wb') as fh:
            fh.write(generar(size))
        with open(os.path.join(OUT, f'maskable-{size}.png'), 'wb') as fh:
            fh.write(generar(size, maskable=True))
    with open(os.path.join(OUT, 'apple-touch-icon.png'), 'wb') as fh:
        fh.write(generar(180, maskable=True))
    with open(os.path.join(OUT, 'badge-96.png'), 'wb') as fh:
        fh.write(generar_insignia(96))
    print('iconos generados en', os.path.normpath(OUT))
