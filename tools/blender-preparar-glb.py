"""
Prepara um .blend para exportar em .glb com as texturas (PrevQuedasRV).

O exportador glTF do Blender so leva a textura quando ela esta ligada direto assim:
    [Image Texture] --Color--> [Principled BSDF] Base Color
e quando o objeto tem um mapa UV. Modelos vindos do SketchUp/3D Warehouse costumam ter
outros nos no meio, shaders diferentes do Principled ou projecao por "Generated/Object"
(sem UV): aparecem no Blender, mas saem brancos no .glb.

Este script:
  0. deixa cada material com UMA saida (todos os renderizadores) ligada a um Principled BSDF.
     Modelos do SketchUp vem com duas saidas, EEVEE -> Principled e Cycles -> Diffuse; o exportador
     pegava a do Cycles e TODAS as cores e texturas saiam brancas (no Material Preview parecia certo);
  e, para cada material com imagem de cor:
  1. garante um Principled BSDF ligado na saida do material;
  2. liga a imagem de cor direto no Base Color (e a entrada Vector da imagem passa a usar UV);
  3. cria UV por projecao cubica nos objetos com esses materiais que nao tem mapa UV.

COMO USAR (faca numa COPIA do .blend):
  1. Aba "Scripting" > botao "Open" > escolha este arquivo > botao "Run Script" (ou Alt+P).
  2. Veja o resumo em Window > Toggle System Console (Windows).
  3. Confira no Material Preview (tecla Z) e exporte em glTF Binary com Images: JPEG.
"""
import bpy
import bmesh

NAO_COR = ('normal', 'bump', 'rough', 'metal', 'spec', 'gloss', 'height', 'disp', 'ao', 'occlusion')


def imagem_de_cor(nodes):
    """Escolhe a imagem de cor do material (ignora normal/rugosidade/etc. e imagens Non-Color)."""
    imgs = [n for n in nodes if n.type == 'TEX_IMAGE' and n.image]
    cor = [n for n in imgs
           if n.image.colorspace_settings.name not in ('Non-Color', 'Linear', 'Linear Rec.709', 'Raw')
           and not any(k in (n.image.name + n.label + n.name).lower() for k in NAO_COR)]
    lista = cor or imgs
    if not lista:
        return None
    return max(lista, key=lambda n: n.image.size[0] * n.image.size[1])


def corrigir_material(mat):
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    img = imagem_de_cor(nodes)
    if img is None:
        return False
    out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None) \
        or next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if out is None:
        out = nodes.new('ShaderNodeOutputMaterial')
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        bsdf.location = (out.location.x - 300, out.location.y)
    mudou = False
    surf = out.inputs['Surface']
    if not (surf.is_linked and surf.links[0].from_node == bsdf):
        links.new(bsdf.outputs['BSDF'], surf)
        mudou = True
    base = bsdf.inputs['Base Color']
    if not (base.is_linked and base.links[0].from_node == img and base.links[0].from_socket.name == 'Color'):
        links.new(img.outputs['Color'], base)
        mudou = True
    # projecao Generated/Object nao existe no glTF: a imagem passa a usar o mapa UV
    vec = img.inputs.get('Vector')
    if vec and vec.is_linked:
        src = vec.links[0].from_node
        if src.type != 'UVMAP' and not (src.type == 'TEX_COORD' and vec.links[0].from_socket.name == 'UV'):
            for l in list(vec.links):
                links.remove(l)
            mudou = True
    return mudou


def criar_uv_cubica(obj, tamanho=1.0):
    """UV por projecao cubica (como em paredes/pisos), sem precisar entrar no Edit Mode."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            co = obj.matrix_world @ loop.vert.co  # usa medidas reais: a textura fica com a mesma escala
            if ax == 0:
                u, v = co.y, co.z
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            loop[uv].uv = (u / tamanho, v / tamanho)
    bm.to_mesh(me)
    bm.free()


def unificar_saida(mat):
    """
    Deixa uma unica saida do material, valendo para todos os renderizadores (target ALL) e ligada a
    um Principled BSDF. Modelos do SketchUp costumam ter duas saidas: EEVEE -> Principled (o que
    aparece no Material Preview) e Cycles -> Diffuse BSDF. O exportador glTF pegava a do Cycles e o
    material saia sem cor. Se so houver Diffuse, cria um Principled com a mesma cor.
    """
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    saidas = [n for n in nodes if n.type == 'OUTPUT_MATERIAL']
    if not saidas:
        return False

    def shader_de(o):
        s = o.inputs['Surface']
        return s.links[0].from_node if s.is_linked else None

    # prefere a saida que ja tem um Principled; depois a ativa
    out = next((o for o in saidas if shader_de(o) and shader_de(o).type == 'BSDF_PRINCIPLED'), None) \
        or next((o for o in saidas if o.is_active_output), saidas[0])
    mudou = False
    for o in saidas:
        if o is not out:
            nodes.remove(o)
            mudou = True
    if out.target != 'ALL':
        out.target = 'ALL'
        mudou = True
    sh = shader_de(out)
    if sh is None or sh.type != 'BSDF_PRINCIPLED':
        bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            bsdf = nodes.new('ShaderNodeBsdfPrincipled')
            bsdf.location = (out.location.x - 300, out.location.y)
            # copia a cor do shader antigo (Diffuse etc.) ou a cor de exibicao do material
            cor = sh.inputs.get('Color') if sh is not None else None
            if cor is not None and cor.is_linked:
                links.new(cor.links[0].from_socket, bsdf.inputs['Base Color'])
            elif cor is not None:
                bsdf.inputs['Base Color'].default_value = cor.default_value
            else:
                bsdf.inputs['Base Color'].default_value = mat.diffuse_color
        links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        mudou = True
    return mudou


saidas_unificadas = []
for mat in bpy.data.materials:
    if mat.use_nodes and mat.node_tree and unificar_saida(mat):
        saidas_unificadas.append(mat.name)

materiais_corrigidos = []
materiais_com_textura = set()
for mat in bpy.data.materials:
    if not mat.use_nodes or not mat.node_tree:
        continue
    if imagem_de_cor(mat.node_tree.nodes):
        materiais_com_textura.add(mat.name)
        if corrigir_material(mat):
            materiais_corrigidos.append(mat.name)

uv_criadas = []
for obj in bpy.data.objects:
    if obj.type != 'MESH' or obj.data.uv_layers:
        continue
    if any(s.material and s.material.name in materiais_com_textura for s in obj.material_slots):
        criar_uv_cubica(obj)
        uv_criadas.append(obj.name)

# Texturas grandes pesam no celular (o Cardboard ainda desenha tudo duas vezes). Reduz as
# maiores que TAMANHO_MAX mantendo a proporcao. Use 2048 se precisar de mais detalhe; 0 desliga.
TAMANHO_MAX = 1024
reduzidas = []
if TAMANHO_MAX:
    for img in bpy.data.images:
        w, h = img.size[0], img.size[1]
        if not img.has_data or max(w, h) <= TAMANHO_MAX:
            continue
        k = TAMANHO_MAX / max(w, h)
        img.scale(max(1, round(w * k)), max(1, round(h * k)))
        if img.packed_file:
            img.pack()  # guarda a versao reduzida no .blend
        reduzidas.append('%s (%dx%d)' % (img.name, w, h))

print('\n=== Preparar para .glb ===')
print('Texturas reduzidas para ate %d px: %d' % (TAMANHO_MAX, len(reduzidas)))
print('Materiais com saida unificada (EEVEE/Cycles -> uma so, com Principled):', len(saidas_unificadas))
print('Materiais com textura de cor:', len(materiais_com_textura))
print('Materiais religados:', len(materiais_corrigidos))
for n in materiais_corrigidos[:40]:
    print('   ', n)
print('Objetos que ganharam UV cubica:', len(uv_criadas))
for n in uv_criadas[:40]:
    print('   ', n)
print('Pronto. Confira no Material Preview (Z) e exporte com Images: JPEG.')
