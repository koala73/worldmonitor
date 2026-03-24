"""
blender-vault-render.py
Photorealistic vault door scene — renders two clips:
  public/vault-idle.mp4   2-second loop, door closed
  public/vault-open.mp4   3-second opening animation

Run headlessly:
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --python scripts/blender-vault-render.py
"""

import bpy
import math
import os

try:
    import mathutils
except ImportError:
    from bpy_extras import mathutils  # fallback

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR    = os.path.normpath(os.path.join(SCRIPT_DIR, '..', 'public'))
os.makedirs(OUT_DIR, exist_ok=True)

# ─── Reset scene ──────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=True)
for col in [bpy.data.meshes, bpy.data.materials,
            bpy.data.lights, bpy.data.cameras]:
    for item in list(col):
        col.remove(item, do_unlink=True)

C = bpy.context
D = bpy.data
scene = C.scene

# ─── Materials ────────────────────────────────────────────────────────────────

def make_pbr(name, base=(0.8,0.8,0.8), metal=0.0, rough=0.5,
             emit=None, emit_str=0.0):
    mat = D.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out  = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value  = (*base, 1.0)
    bsdf.inputs['Metallic'].default_value    = metal
    bsdf.inputs['Roughness'].default_value   = rough
    if emit:
        # Blender 4.x uses 'Emission Color' + 'Emission Strength'
        ec = bsdf.inputs.get('Emission Color') or bsdf.inputs.get('Emission')
        if ec:
            ec.default_value = (*emit, 1.0)
        es = bsdf.inputs.get('Emission Strength')
        if es:
            es.default_value = emit_str
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    return mat

MAT = {
    'steel' : make_pbr('Steel',  (0.48,0.52,0.58), metal=1.0, rough=0.36),
    'chrome': make_pbr('Chrome', (0.82,0.86,0.92), metal=1.0, rough=0.04),
    'band'  : make_pbr('Band',   (0.30,0.36,0.46), metal=1.0, rough=0.16),
    'dark'  : make_pbr('Dark',   (0.014,0.016,0.020), metal=0.15, rough=0.93),
    'wall'  : make_pbr('Wall',   (0.025,0.030,0.042), metal=0.0,  rough=0.97),
    'floor' : make_pbr('Floor',  (0.055,0.065,0.090), metal=0.65, rough=0.28),
    'frame' : make_pbr('Frame',  (0.038,0.048,0.070), metal=0.92, rough=0.22),
    'mount' : make_pbr('Mount',  (0.08,0.12,0.20),   metal=0.88, rough=0.12),
    'glow'  : make_pbr('Glow',   (0.02,0.002,0.001), metal=0.0, rough=0.9,
                        emit=(1.0, 0.07, 0.02), emit_str=14.0),
}

def assign(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)

# ─── Geometry helpers ─────────────────────────────────────────────────────────
# Blender coords: X=right, Z=up, Y=into screen (depth).
# Door faces +Y. Camera is at positive Y looking in -Y direction.

def add_box(name, loc, half_size, mat):
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=loc)
    obj = C.active_object
    obj.name = name
    obj.scale = half_size
    bpy.ops.object.transform_apply(scale=True)
    assign(obj, mat)
    obj.cast_shadow = obj.visible_shadow = True
    return obj

def add_cyl(name, loc, r, h, segs=48, mat=None,
            rx=0.0, ry=0.0, rz=0.0):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=r, depth=h, vertices=segs, location=loc)
    obj = C.active_object
    obj.name = name
    obj.rotation_euler = (rx, ry, rz)
    bpy.ops.object.transform_apply(rotation=True)
    if mat:
        assign(obj, mat)
    return obj

def add_torus(name, loc, R, r, maj=64, mn=16, mat=None,
              rx=0.0, ry=0.0, rz=0.0):
    bpy.ops.mesh.primitive_torus_add(
        location=loc, major_radius=R, minor_radius=r,
        major_segments=maj, minor_segments=mn)
    obj = C.active_object
    obj.name = name
    obj.rotation_euler = (rx, ry, rz)
    bpy.ops.object.transform_apply(rotation=True)
    if mat:
        assign(obj, mat)
    return obj

# ─── Room ─────────────────────────────────────────────────────────────────────

add_box('BackWall',  (0, -9,  0),     (12, 0.25, 8),  MAT['wall'])
add_box('Floor',     (0, -4, -3.6),   (12, 8, 0.25),  MAT['floor'])
add_box('Ceiling',   (0, -4,  5.2),   (12, 8, 0.25),  MAT['wall'])
add_box('LeftWall',  (-9, -4, 0),     (0.25, 8, 8),   MAT['wall'])
add_box('RightWall', ( 9, -4, 0),     (0.25, 8, 8),   MAT['wall'])

# ─── Vault door frame (rectangular, 4 bars + tunnel) ─────────────────────────

FW = 3.28    # inner width
FH = 4.28    # inner height
FT = 0.55    # beam thickness
FD = 3.8     # depth (into -Y)

fy = -FD / 2  # Y center of frame bars

add_box('FrTop',   (0,          fy,  FH/2 + FT/2), (FW/2 + FT, FD/2, FT/2),   MAT['frame'])
add_box('FrBot',   (0,          fy, -FH/2 - FT/2), (FW/2 + FT, FD/2, FT/2),   MAT['frame'])
add_box('FrLeft',  (-FW/2-FT/2, fy,  0),           (FT/2, FD/2, FH/2),         MAT['frame'])
add_box('FrRight', ( FW/2+FT/2, fy,  0),           (FT/2, FD/2, FH/2),         MAT['frame'])

# Chrome inner trim lips on frame
for sx, n in [(-1,'TrimL'),(1,'TrimR')]:
    add_box(n, (sx*FW/2, -0.01, 0), (0.020, 0.035, FH/2), MAT['chrome'])

# ─── Vault door halves ────────────────────────────────────────────────────────

DW = 1.54   # half-width
DH = 4.20   # height
DD = 0.58   # thickness

door_L = add_box('DoorLeft',  (-DW/2, 0, 0), (DW/2, DD/2, DH/2), MAT['steel'])
door_R = add_box('DoorRight', ( DW/2, 0, 0), (DW/2, DD/2, DH/2), MAT['steel'])

for sx, s in [(-1,'L'),(1,'R')]:
    cx = sx * DW/2

    # Outer chrome edge (wall-side)
    add_box(f'OE{s}',  (cx + sx*(DW/2+0.021), 0, 0),
            (0.021, (DD+0.018)/2, (DH+0.044)/2), MAT['chrome'])

    # Seam strip (center split)
    add_box(f'Sm{s}',  (cx - sx*(DW/2-0.007), 0, 0),
            (0.007, (DD+0.008)/2, DH/2), MAT['chrome'])

    # Top cap
    add_box(f'CT{s}',  (cx, 0,  DH/2 + 0.018),
            ((DW+0.045)/2, (DD+0.018)/2, 0.018), MAT['chrome'])

    # Bottom cap
    add_box(f'CB{s}',  (cx, 0, -DH/2 - 0.018),
            ((DW+0.045)/2, (DD+0.018)/2, 0.018), MAT['chrome'])

    # Raised horizontal bands (decorative machined strips)
    for bz in [-1.45, -0.48, 0.48, 1.45]:
        add_box(f'Bd{s}_{int(bz*100)}',
                (cx, -DD/2 - 0.009, bz),
                ((DW-0.10)/2, 0.009, DD*0.034), MAT['band'])

    # Locking pin cylinders on split edge (3 per half)
    for i, pz in enumerate([-DH*0.27, 0, DH*0.27]):
        add_cyl(f'Pin{s}{i}',
                (cx - sx*(DW/2+0.048), -DD/4+0.05, pz),
                0.036, 0.13, 10, MAT['chrome'],
                rx=0, ry=math.pi/2, rz=0)

    # Scanner mounting half-disc on door face (purely decorative chrome plate)
    # Implemented as a flat cylinder half – approximated with a thin cylinder
    add_cyl(f'MountRing{s}',
            (0, -DD/2 - 0.012, 0), 0.72, 0.022, 64, MAT['mount'],
            rx=math.pi/2)

# ─── Fingerprint scanner (centered, on door face front) ───────────────────────

SF_Y = -DD/2  # Y coordinate of door front face

# Chrome barrel rings (stepped, recessed)
ring_specs = [(0.55, 0.00), (0.43, 0.07), (0.32, 0.14), (0.22, 0.20)]
for i, (R, depth) in enumerate(ring_specs):
    add_torus(f'Ring{i}', (0, SF_Y - depth, 0), R, 0.024,
              64, 20, MAT['chrome'], rx=math.pi/2)

# Scanner glow ring
glow_ring = add_torus('GlowRing', (0, SF_Y - 0.02, 0), 0.46, 0.040,
                       64, 20, MAT['glow'], rx=math.pi/2)

# Dark sensor glass
add_cyl('SensorGlass', (0, SF_Y - 0.16, 0), 0.19, 0.06, 64,
        MAT['dark'], rx=math.pi/2)

# ─── Lights ───────────────────────────────────────────────────────────────────

def point_spot_at(spot_obj, target=(0, 0, 0)):
    loc   = mathutils.Vector(spot_obj.location)
    tgt   = mathutils.Vector(target)
    direc = (tgt - loc).normalized()
    q     = direc.to_track_quat('-Z', 'Y')
    spot_obj.rotation_euler = q.to_euler()

def add_spot(name, loc, energy, color=(1,1,1),
             angle=35, blend=0.3, target=(0,0,0)):
    bpy.ops.object.light_add(type='SPOT', location=loc)
    obj = C.active_object
    obj.name = name
    obj.data.energy    = energy
    obj.data.spot_size = math.radians(angle)
    obj.data.spot_blend = blend
    obj.data.color     = color
    obj.data.use_shadow = True
    point_spot_at(obj, target)
    return obj

def add_area(name, loc, energy, size=2.0, color=(1,1,1), rot=(0,0,0)):
    bpy.ops.object.light_add(type='AREA', location=loc)
    obj = C.active_object
    obj.name = name
    obj.data.energy = energy
    obj.data.size   = size
    obj.data.color  = color
    obj.rotation_euler = rot
    return obj

# Hard key from upper-left (creates sharp shadows in door recesses)
add_spot('Key', (-5, 4, 6.5), 28000, (0.94,0.97,1.0),
         angle=26, blend=0.25, target=(0, -0.4, 0.2))

# Warm floor bounce from lower-right
add_spot('Fill', (5, 2.5, -2.5), 9000, (0.88,0.72,0.50),
         angle=50, blend=0.5, target=(0, -0.5, 0.5))

# Cold rim from behind-right (edge glow on chrome)
add_spot('Rim', (4, -5, 3), 14000, (0.35,0.50,1.0),
         angle=38, blend=0.4, target=(0, 0, 0))

# Subtle overhead area (ceiling bounce)
add_area('Overhead', (0, -1, 4.8), 5000, size=3.5,
         color=(0.80,0.88,1.0), rot=(0, 0, 0))

# Interior flood (off until door opens — animated below)
bpy.ops.object.light_add(type='POINT', location=(0, -9, 0))
interior = C.active_object
interior.name = 'Interior'
interior.data.energy     = 0
interior.data.color      = (0.80, 0.90, 1.0)
interior.data.shadow_soft_size = 4.0
interior.data.use_shadow = False

# ─── Camera ───────────────────────────────────────────────────────────────────

bpy.ops.object.camera_add(location=(0, 5.8, 0.42))
cam = C.active_object
cam.name = 'Camera'
scene.camera = cam
cam.data.lens = 38          # 38mm ≈ 53° diagonal FOV on 35mm sensor
cam.data.dof.use_dof = True
cam.data.dof.focus_distance = 5.8
cam.data.dof.aperture_fstop = 5.6   # subtle depth of field

point_spot_at(cam, (0, 0, 0.18))  # look slightly above door center

# ─── World (very dark vault room) ─────────────────────────────────────────────

world = D.worlds.get('World') or D.worlds.new('World')
scene.world = world
world.use_nodes = True
bg_node = world.node_tree.nodes.get('Background')
if bg_node:
    bg_node.inputs['Color'].default_value    = (0.004, 0.006, 0.010, 1.0)
    bg_node.inputs['Strength'].default_value = 0.06

# ─── Render settings ──────────────────────────────────────────────────────────

render = scene.render
render.resolution_x = 1280
render.resolution_y = 800
render.fps          = 30

# Use EEVEE (fast; still dramatic with proper lights)
render.engine = 'BLENDER_EEVEE_NEXT'

try:
    eevee = scene.eevee
    # Shadows
    eevee.shadow_cube_size   = '2048'
    eevee.shadow_cascade_size = '2048'
    # AO
    eevee.use_gtao      = True
    eevee.gtao_distance = 0.30
    # SSR (screen-space reflections)
    eevee.use_ssr             = True
    eevee.use_ssr_refraction  = True
    eevee.ssr_quality         = 0.5
    # Samples
    eevee.taa_render_samples  = 64
    # Bloom (Blender ≤4.1 — silently ignored on 4.2+)
    if hasattr(eevee, 'use_bloom'):
        eevee.use_bloom          = True
        eevee.bloom_threshold    = 0.80
        eevee.bloom_intensity    = 0.08
        eevee.bloom_radius       = 6
except Exception as e:
    print(f'[vault-render] EEVEE settings warning: {e}')

# Compositor (bloom via Glare node — works on all Blender 3.x/4.x)
scene.use_nodes = True
ct = scene.node_tree
ct.nodes.clear()
rl       = ct.nodes.new('CompositorNodeRLayers')
glare    = ct.nodes.new('CompositorNodeGlare')
glare.glare_type = 'BLOOM'
glare.threshold  = 0.80
glare.mix        = -0.80   # 0=full glare, -1=original+glare blend
glare.size       = 8
comp = ct.nodes.new('CompositorNodeComposite')
ct.links.new(rl.outputs['Image'], glare.inputs['Image'])
ct.links.new(glare.outputs['Image'], comp.inputs['Image'])

# Output format
render.image_settings.file_format = 'FFMPEG'
render.ffmpeg.format               = 'MPEG4'
render.ffmpeg.codec                = 'H264'
render.ffmpeg.constant_rate_factor = 'MEDIUM'
render.ffmpeg.audio_codec          = 'NONE'

# ─── Helper: keyframe a data-path ─────────────────────────────────────────────

def kf(obj, frame, **props):
    scene.frame_set(frame)
    for prop, val in props.items():
        if prop == 'loc':
            obj.location = val
            obj.keyframe_insert(data_path='location')
        elif prop == 'energy':
            obj.data.energy = val
            obj.data.keyframe_insert(data_path='energy')

# ─── Render 1: IDLE (2-second loop, door closed) ──────────────────────────────
# Very subtle camera breathe, door stays closed.

scene.frame_start = 1
scene.frame_end   = 60

for obj, cx in [(door_L, -DW/2), (door_R, DW/2)]:
    kf(obj, 1,  loc=(cx, 0, 0))
    kf(obj, 60, loc=(cx, 0, 0))

kf(cam, 1,  loc=(0, 5.80, 0.42))
kf(cam, 30, loc=(0, 5.76, 0.40))   # tiny breathing motion
kf(cam, 60, loc=(0, 5.80, 0.42))

kf(interior, 1,  energy=0)
kf(interior, 60, energy=0)

render.filepath = os.path.join(OUT_DIR, 'vault-idle')
print('\n[vault-render] Rendering vault-idle.mp4 (60 frames) ...')
bpy.ops.render.render(animation=True)
print('[vault-render] vault-idle.mp4 done.')

# ─── Render 2: OPEN animation (3 seconds) ────────────────────────────────────
# Hold 0.5s, then bolts retract, door slams open, interior floods, camera pushes.

scene.frame_start = 1
scene.frame_end   = 90

for obj, cx in [(door_L, -DW/2), (door_R, DW/2)]:
    kf(obj, 1,   loc=(cx, 0, 0))
    kf(obj, 18,  loc=(cx, 0, 0))             # hold closed
    kf(obj, 78,  loc=(cx * 5.8, 0, 0))       # slam wide open

# Smooth ease on door open keyframes
for obj in [door_L, door_R]:
    if obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'BEZIER'
                kp.easing = 'EASE_IN_OUT'

# Camera push through door
kf(cam, 1,  loc=(0, 5.80, 0.42))
kf(cam, 18, loc=(0, 5.80, 0.42))
kf(cam, 90, loc=(0, -1.50, 0.35))

for fc in cam.animation_data.action.fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = 'BEZIER'
        kp.easing = 'EASE_IN_OUT'

# Interior flood
kf(interior, 1,   energy=0)
kf(interior, 18,  energy=0)
kf(interior, 78,  energy=50000)
kf(interior, 90,  energy=90000)

render.filepath = os.path.join(OUT_DIR, 'vault-open')
print('\n[vault-render] Rendering vault-open.mp4 (90 frames) ...')
bpy.ops.render.render(animation=True)
print('[vault-render] vault-open.mp4 done.')

print(f'\n=== Render complete. Files in: {OUT_DIR} ===')
