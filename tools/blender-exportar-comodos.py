"""
Exporta um .glb por comodo a partir de uma casa inteira no Blender (PrevQuedasRV).

Para casas que NAO estao separadas em collections: cada comodo e uma ou mais areas retangulares
(em metros, coordenadas do Blender, vista de cima) e uma faixa de altura. Vao para o arquivo do
comodo os objetos cuja caixa envolvente toca a area (com uma folga para pegar as paredes em volta).
Paredes e lajes compridas entram em todos os comodos que tocam - e o que se quer.

USO (sempre numa COPIA do .blend; rode antes o blender-preparar-glb.py para cores/texturas):
  blender -b copia.blend --python blender-preparar-glb.py --python blender-exportar-comodos.py -- <pasta> [--mapa]
    --mapa  so desenha a planta de cada pavimento com as areas coloridas (para conferir), sem exportar.
Ou pela aba Scripting do Blender (ajuste PASTA abaixo).

Para outra casa: troque a lista COMODOS. Descubra as coordenadas pela planta (--mapa) ou passando o
mouse no Blender (vista de cima, tecla 7) - X e Y aparecem no painel N > Item.
"""
import bpy
import sys
import os
from mathutils import Vector

PASTA = os.path.join(os.path.expanduser('~'), 'Downloads', 'comodos')
FOLGA = 0.25          # m em volta da area: pega as paredes que cercam o comodo
# Objetos com mais triangulos que isto sao simplificados (modificador Decimate) na exportacao.
# Enfeites de 30 mil triangulos (fruteira, vasos) pesam no celular e ninguem nota a diferenca.
# 0 desliga. O .blend nao muda: o modificador so e aplicado no arquivo exportado.
LIMITE_TRIANGULOS_OBJETO = 4000
TERREO = (-0.5, 3.0)  # faixa de altura (z) de cada pavimento
SUPERIOR = (3.0, 7.6)
TUDO = (-0.5, 7.6)

# nome do arquivo, nome para exibir, altura, lista de retangulos (x0, x1, y0, y1)
COMODOS = [
    ('01-frente',            'Frente (jardim e garagem)',  TUDO,     [(3.2, 13.4, -0.5, 6.85)]),
    ('02-sala',              'Sala',                       TERREO,   [(9.6, 13.4, 6.85, 10.6)]),
    ('03-cozinha-jantar',    'Cozinha e jantar',           TERREO,   [(9.6, 13.4, 10.6, 15.5)]),
    ('04-escada-corredor',   'Escada e corredor',          TERREO,   [(5.0, 9.6, 6.85, 9.6), (8.3, 9.6, 9.6, 15.5)]),
    ('05-banheiro',          'Banheiro',                   TERREO,   [(5.0, 8.3, 9.6, 11.1)]),
    ('06-quarto',            'Quarto',                     TERREO,   [(5.0, 8.3, 11.1, 15.5)]),
    ('07-quintal-corredor',  'Quintal e corredor lateral', TUDO,     [(3.2, 13.4, 15.5, 25.5), (3.2, 5.0, 6.85, 15.5)]),
    ('08-sala-superior',     'Sala de cima (rede)',        SUPERIOR, [(9.6, 13.4, 6.85, 15.5)]),
    ('09-escada-corredor-superior', 'Escada e corredor (andar de cima)', SUPERIOR, [(5.0, 9.6, 6.85, 9.6), (8.3, 9.6, 9.6, 15.5)]),
    ('10-banheiro-superior', 'Banheiro (andar de cima)',   SUPERIOR, [(5.0, 8.3, 9.6, 11.1)]),
    ('11-quarto-superior',   'Quarto (andar de cima)',     SUPERIOR, [(5.0, 8.3, 11.1, 15.5)]),
]

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if args and not args[0].startswith('--'):
    PASTA = args[0]
SO_MAPA = '--mapa' in args
os.makedirs(PASTA, exist_ok=True)
cena = bpy.context.scene


def caixa(o):
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return (min(p.x for p in pts), max(p.x for p in pts), min(p.y for p in pts), max(p.y for p in pts),
            min(p.z for p in pts), max(p.z for p in pts))


def toca(b, rects, zr):
    if b[5] < zr[0] or b[4] > zr[1]:
        return False
    return any(b[0] <= x1 + FOLGA and b[1] >= x0 - FOLGA and b[2] <= y1 + FOLGA and b[3] >= y0 - FOLGA
               for x0, x1, y0, y1 in rects)


def tri_obj(o):
    t = sum(len(p.vertices) - 2 for p in o.data.polygons)
    d = o.modifiers.get('PrevQuedas-simplificar')
    return int(t * d.ratio) if d else t


def triangulos(objs):
    return sum(tri_obj(o) for o in objs if o.type == 'MESH')


malhas = [o for o in cena.objects if o.type == 'MESH']
simplificados = 0
if LIMITE_TRIANGULOS_OBJETO:
    for o in malhas:
        t = sum(len(p.vertices) - 2 for p in o.data.polygons)
        if t > LIMITE_TRIANGULOS_OBJETO and not o.modifiers.get('PrevQuedas-simplificar'):
            m = o.modifiers.new('PrevQuedas-simplificar', 'DECIMATE')
            m.ratio = LIMITE_TRIANGULOS_OBJETO / t
            simplificados += 1
    print('Objetos simplificados para ate %d triangulos: %d' % (LIMITE_TRIANGULOS_OBJETO, simplificados))
caixas = {o.name: caixa(o) for o in malhas}


def desenhar_mapa():
    """Planta de cada pavimento (corte acima do piso) com as areas dos comodos coloridas."""
    cores = [(1, .3, .3), (.3, .6, 1), (1, .8, .2), (.5, 1, .4), (1, .4, 1), (.3, 1, 1), (1, .6, .3), (.6, .4, 1)]
    xs = [b[0] for b in caixas.values()] + [b[1] for b in caixas.values()]
    ys = [b[2] for b in caixas.values()] + [b[3] for b in caixas.values()]
    X0, X1, Y0, Y1 = min(xs) - .3, max(xs) + .3, min(ys) - .3, max(ys) + .3
    cam = bpy.data.cameras.new('mapa'); cam.type = 'ORTHO'; cam.ortho_scale = max(X1 - X0, Y1 - Y0); cam.clip_start = .001
    co = bpy.data.objects.new('mapa', cam); cena.collection.objects.link(co); cena.camera = co
    cena.render.engine = 'BLENDER_WORKBENCH'
    sh = cena.display.shading; sh.light = 'FLAT'; sh.color_type = 'MATERIAL'; sh.show_object_outline = True
    sh.show_xray = False
    cena.render.resolution_x = int((X1 - X0) * 60); cena.render.resolution_y = int((Y1 - Y0) * 60)
    for nome_pav, corte, zr in (('terreo', 2.0, TERREO), ('superior', 4.9, SUPERIOR)):
        extras = []
        for i, (arq, nome, z, rects) in enumerate(COMODOS):
            if z is not zr and z is not TUDO:
                continue
            m = bpy.data.materials.new('area-' + arq); m.diffuse_color = cores[i % len(cores)] + (1,)
            for x0, x1, y0, y1 in rects:
                for (sx, sy, cx, cy) in ((x1 - x0, .07, (x0 + x1) / 2, y0 + .035), (x1 - x0, .07, (x0 + x1) / 2, y1 - .035),
                                         (.07, y1 - y0, x0 + .035, (y0 + y1) / 2), (.07, y1 - y0, x1 - .035, (y0 + y1) / 2)):
                    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, corte - .03)); o = bpy.context.active_object
                    o.scale = (sx, sy, .01); o.data.materials.append(m); extras.append(o)
            x0, x1, y0, y1 = rects[0]
            bpy.ops.object.text_add(location=(x0 + .12, (y0 + y1) / 2, corte - .02)); t = bpy.context.active_object
            t.data.body = arq.split('-', 1)[0]; t.data.size = .5; t.data.materials.append(m); extras.append(t)
        co.location = ((X0 + X1) / 2, (Y0 + Y1) / 2, corte)
        cena.render.filepath = os.path.join(PASTA, 'mapa-' + nome_pav + '.png')
        bpy.ops.render.render(write_still=True)
        for o in extras:
            bpy.data.objects.remove(o, do_unlink=True)
        print('MAPA', cena.render.filepath)


if SO_MAPA:
    desenhar_mapa()
else:
    resumo = []
    for arq, nome, zr, rects in COMODOS:
        sel = [o for o in malhas if toca(caixas[o.name], rects, zr)]
        bpy.ops.object.select_all(action='DESELECT')
        for o in sel:
            o.select_set(True)
        caminho = os.path.join(PASTA, arq + '.glb')
        bpy.ops.export_scene.gltf(filepath=caminho, export_format='GLB', use_selection=True,
                                  export_image_format='JPEG', export_lights=False, export_cameras=False,
                                  export_apply=True)  # aplica a simplificacao (Decimate) no arquivo
        mb = os.path.getsize(caminho) / 1e6
        resumo.append((arq, nome, len(sel), triangulos(sel), mb))
        print('COMODO %-30s %4d objetos %8d triangulos %6.1f MB' % (arq, len(sel), triangulos(sel), mb))
    print('Arquivos em', PASTA)
