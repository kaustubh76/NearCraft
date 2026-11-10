import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const MATERIALS = new Set(['oak_planks', 'cobblestone', 'stone_bricks', 'stone', 'dirt', 'glass', 'bricks', 'oak_log'])
const HARVEST = new Set(['oak_log', 'oak_planks', 'dirt', 'sand'])
const RECIPES = { oak_planks: { ingredient: 'oak_log', input: 1, output: 4 }, stick: { ingredient: 'oak_planks', input: 2, output: 4 }, stone_bricks: { ingredient: 'stone', input: 4, output: 4 } }
const AIR = new Set(['air', 'cave_air', 'void_air'])
const description = plan => plan.action === 'craft' ? `craft ${plan.outputCount} ${plan.item}` : plan.action === 'gather' ? `gather ${plan.count} ${plan.item}` : plan.action === 'build_structure' ? `${plan.structure || 'custom'} structure (${plan.placements.length} blocks)` : `${plan.width}x${plan.depth} ${plan.action === 'build_shelter' ? 'shelter' : 'platform'}`
const ACTIVE = new Set(['running', 'finishing', 'paused', 'blocked', 'reconciliation_required'])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = position => position.join(',')
const itemName = value => { const name = String(value || '').replace(/^minecraft:/, '').toLowerCase(); return name === 'sticks' ? 'stick' : name }
const counts = items => {
  const result = {}
  for (const item of items) if (item?.count > 0) result[item.name] = (result[item.name] || 0) + item.count
  return result
}
const equal = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(name => (a[name] || 0) === (b[name] || 0))
const delta = (before, item, count) => ({ ...before, [item]: (before[item] || 0) + count })
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, ordered(value[name])])) : value
const rawHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hash = value => rawHash(ordered(value))
const xyz = value => Array.isArray(value) ? value : value && [value.x, value.y, value.z]
const integerPosition = value => Array.isArray(value) && value.length === 3 && value.every(Number.isSafeInteger)

export function compileTaskPlan(input, region) {
  if (!region || !integerPosition(xyz(region.min)) || !integerPosition(xyz(region.max)) ||
      !integerPosition(region.origin) || !integerPosition(region.sourceChest) || !integerPosition(region.destinationChest)) throw Error('This agent has no registered task plot and chests yet.')
  const min = xyz(region.min), max = xyz(region.max)
  const inside = p => integerPosition(p) && p.every((n, i) => n >= min[i] && n <= max[i])
  if (!inside(region.sourceChest) || !inside(region.destinationChest) || key(region.sourceChest) === key(region.destinationChest)) throw Error('Registered task chests are invalid.')
  const usable = p => inside(p) && p[0] >= min[0] + 2 && p[2] >= min[2] + 2 && p[1] >= min[1] &&
    ![region.sourceChest, region.destinationChest].some(chest => key(chest) === key(p))
  if (input.action === 'craft') {
    const item = itemName(input.item), recipe = RECIPES[item], count = input.count
    if (!recipe || !Number.isSafeInteger(count) || count < 1 || count > 64) throw Error('Craft oak_planks, sticks or stone_bricks; request 1 to 64 output items.')
    const batches = Math.ceil(count / recipe.output)
    return { action: 'craft', item, count, batches, outputCount: batches * recipe.output, recipe: { ...recipe }, source: [...region.sourceChest] }
  }
  if (input.action === 'gather') {
    const item = itemName(input.item), count = input.count
    if (!HARVEST.has(item) || !Number.isSafeInteger(count) || count < 1 || count > 16) throw Error('Gather 1 to 16 oak_log, oak_planks, dirt or exposed sand blocks in your own plot.')
    let positions = null
    if (input.positions !== undefined) {
      if (!Array.isArray(input.positions) || input.positions.length < count || input.positions.length > 16) throw Error('Gather positions must identify up to 16 own-plot cells.')
      positions = input.positions.map(offset => {
        if (!integerPosition(offset)) throw Error('Gather offsets must be integer triples.')
        const position = offset.map((n, i) => n + region.origin[i])
        if (!usable(position)) throw Error('Gathering cannot touch foundations, task chests, the access strip or another plot.')
        return position
      })
      if (new Set(positions.map(key)).size !== positions.length) throw Error('Gather cells must be distinct.')
    }
    return { action: 'gather', item, count, positions, bounds: { min: [...min], max: [...max] }, source: [...region.sourceChest] }
  }
  if (['deliver', 'collect'].includes(input.action)) {
    const item = itemName(input.item), count = input.count
    if (!/^[a-z0-9_]{1,64}$/.test(item) || !Number.isSafeInteger(count) || count < 1 || count > 64) throw Error('Delivery needs an item and a count from 1 to 64.')
    const source = input.source ?? region.sourceChest, destination = input.destination ?? region.destinationChest
    if (!integerPosition(source) || !integerPosition(destination)) throw Error('Material tasks need registered integer chest coordinates.')
    if (key(source) !== key(region.sourceChest) || key(destination) !== key(region.destinationChest)) throw Error('Material tasks can use only your registered source and destination chests.')
    if (input.action === 'collect') return { action: 'collect', item, count, source: [...source] }
    return { action: 'deliver', item, count, source: [...source], destination: [...destination] }
  }
  if (input.action === 'build_structure') {
    const material = itemName(input.material || 'oak_planks'), offset = input.offset ?? [0, 0, 0]
    if (!MATERIALS.has(material) || !integerPosition(offset) || offset.some(n => Math.abs(n) > 16)) throw Error('Structure needs an approved full-block material and bounded integer origin offset.')
    let cells = input.placements, clearances
    const structure = input.structure
    if (input.parts !== undefined) {
      if (cells !== undefined || !Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 32 ||
        input.voids !== undefined && (!Array.isArray(input.voids) || input.voids.length > 32) ||
        !['width', 'depth', 'height'].every(field => Number.isSafeInteger(input[field]) && input[field] > 0)) throw Error('Compact structures need 1 to 32 parts, up to 32 voids and declared width, depth and height; choose parts or placements.')
      const volume = box => {
        if (!integerPosition(box?.min) || !integerPosition(box?.max) || box.min.some((n, i) => n < 0 || n > box.max[i]) ||
          box.max.some((n, i) => n > (i === 1 ? 5 : 7)) || box.min[1] + offset[1] < 0 || box.max[1] + offset[1] > 5) throw Error('Every compact part or void must fit integer bounds inside 8x6x8 at the requested origin height.')
        const offsets = []
        for (let y = box.min[1]; y <= box.max[1]; y++) for (let x = box.min[0]; x <= box.max[0]; x++) for (let z = box.min[2]; z <= box.max[2]; z++) offsets.push([x, y, z])
        return offsets
      }
      const union = new Map()
      for (const part of input.parts) {
        const block = itemName(part?.material || material)
        if (!MATERIALS.has(block)) throw Error('A compact part uses an unsupported building material.')
        for (const relative of volume(part)) {
          const existing = union.get(key(relative))
          if (existing && existing.material !== block) throw Error('Overlapping compact parts disagree about a block material.')
          union.set(key(relative), { offset: relative, material: block })
        }
      }
      const emptyCells = new Map()
      for (const empty of input.voids || []) for (const relative of volume(empty)) {
        const position = relative.map((n, i) => n + offset[i] + region.origin[i])
        if (!usable(position)) throw Error('A declared opening crosses your authorized plot, task chests or reserved access strip.')
        emptyCells.set(key(relative), position); union.delete(key(relative))
      }
      if (emptyCells.size) clearances = [...emptyCells.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2])
      cells = [...union.values()]
    } else if (input.voids !== undefined) throw Error('Voids require compact parts; explicit placements already specify their empty cells.')
    if (cells === undefined) {
      const { width, depth, height } = input
      if (!['house', 'tower', 'bridge', 'wall', 'stairs', 'arch'].includes(structure) ||
        ![width, depth, height].every(n => Number.isSafeInteger(n) && n >= 1) || width > 8 || depth > 8 || height > 6) throw Error('Provide explicit relative placements or a bounded house, tower, bridge, wall, stairs or arch descriptor.')
      if (['house', 'tower'].includes(structure) && (width < 3 || depth < 3 || height < 3)) throw Error('A hollow house or tower needs at least 3x3x3 blocks.')
      if (structure === 'arch' && (width < 3 || height < 3)) throw Error('An arch needs width and height of at least 3 blocks.')
      cells = []
      const openings = []
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
        if (structure === 'arch' && x > 0 && x < width - 1 && y < height - 1) {
          const position = [x, y, z].map((n, i) => n + offset[i] + region.origin[i])
          if (y + offset[1] < 0 || y + offset[1] > 5 || !usable(position)) throw Error('The arch opening crosses your authorized plot, access strip or height limit.')
          openings.push(position); continue
        }
        const edge = x === 0 || x === width - 1 || z === 0 || z === depth - 1
        if (['house', 'tower'].includes(structure) && y !== 0 && y !== height - 1 && (!edge || z === 0 && x === Math.floor(width / 2) && y < 3)) continue
        if (structure === 'bridge' && y !== height - 1 && !((x === 0 || x === width - 1) && (z === 0 || z === depth - 1))) continue
        if (structure === 'stairs' && y >= Math.min(height, z + 1)) continue
        cells.push({ offset: [x, y, z] })
      }
      if (openings.length) clearances = openings
    }
    if (!Array.isArray(cells) || cells.length < 1 || cells.length > 256) throw Error('A custom structure needs 1 to 256 explicit blocks.')
    if (['width', 'depth', 'height'].some(field => input[field] !== undefined)) {
      if (!['width', 'depth', 'height'].every(field => input[field] !== undefined)) throw Error('Declare structure width, depth and height together or omit all three for explicit placements.')
      if (cells.some(cell => !integerPosition(cell?.offset))) throw Error('Structure cells need integer offset triples.')
      for (const [field, axis] of [['width', 0], ['depth', 2], ['height', 1]]) if (input[field] !== undefined) {
        const extent = Math.max(...cells.map(cell => cell.offset[axis])) - Math.min(...cells.map(cell => cell.offset[axis])) + 1
        if (!Number.isSafeInteger(input[field]) || input[field] !== extent) throw Error(`Declared structure ${field} does not match its final block bounding box.`)
      }
    }
    const placements = cells.map(cell => {
      const relative = cell?.offset, block = itemName(cell?.material || material)
      if (!integerPosition(relative) || relative[0] < 0 || relative[0] > 7 || relative[2] < 0 || relative[2] > 7 ||
        relative[1] < 0 || relative[1] > 5 || relative[1] + offset[1] < 0 || relative[1] + offset[1] > 5 || !MATERIALS.has(block)) throw Error('Structure blocks must fit an 8x6x8 full-block blueprint.')
      const position = relative.map((n, i) => n + offset[i] + region.origin[i])
      if (!usable(position)) throw Error('The structure crosses your authorized plot, task chests or reserved access strip.')
      return { position, material: block }
    }).sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0] || a.position[2] - b.position[2])
    if (new Set(placements.map(placement => key(placement.position))).size !== placements.length) throw Error('A structure cannot place two blocks in the same cell.')
    const bill = counts(placements.map(placement => ({ name: placement.material, count: 1 })))
    return { action: 'build_structure', ...(structure ? { structure } : {}), material, offset: [...offset], placements, bill, ...(clearances ? { clearances } : {}), source: [...region.sourceChest] }
  }
  if (!['build_platform', 'build_shelter'].includes(input.action)) throw Error('Unsupported physical task.')
  const width = input.width, depth = input.depth, material = itemName(input.material || 'oak_planks')
  const maximum = input.action === 'build_shelter' ? 6 : 8
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(depth) || width < 2 || depth < 2 || width > maximum || depth > maximum || !MATERIALS.has(material)) throw Error(`Build dimensions must be 2 to ${maximum}; use oak_planks, cobblestone, stone_bricks or stone.`)
  if (input.action === 'build_shelter' && (width < 4 || depth < 4)) throw Error('A small shelter needs dimensions from 4 to 6.')
  const placements = []
  const height = input.action === 'build_shelter' ? 4 : 1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
    if (y > 0 && y < height - 1 && x !== 0 && x !== width - 1 && z !== 0 && z !== depth - 1) continue
    if (y > 0 && y < height - 1 && z === 0 && x === Math.floor(width / 2)) continue
    const target = [region.origin[0] + x, region.origin[1] + y, region.origin[2] + z]
    if (!inside(target) || [region.sourceChest, region.destinationChest].some(chest => key(chest) === key(target))) throw Error('The requested build does not fit your authorized plot.')
    placements.push({ position: target, material })
  }
  return { action: input.action, width, depth, material, placements, source: [...region.sourceChest] }
}

export class NativeTaskAdapter {
  constructor({ bot, rootDirectory, region, check, playSpawn, onDiagnostic }) {
    this.bot = bot; this.region = region; this.check = check; this.playSpawn = playSpawn; this.onDiagnostic = onDiagnostic
    const dependencies = join(rootDirectory, 'tests/compatibility/node_modules')
    this.Vec3 = require(join(dependencies, 'vec3')).Vec3
    const { goals, Movements } = require(join(dependencies, 'mineflayer-pathfinder'))
    this.goals = goals
    if (playSpawn) {
      const previous = bot.pathfinder.movements
      const movements = new Movements(bot)
      // Grid diagonals can clip a placed block from the bot's fractional body pose.
      movements.getMoveDiagonal = () => {}
      movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false
      movements.canOpenDoors = false; movements.scafoldingBlocks = []; movements.maxDropDown = 1
      movements.entitiesToAvoid.add('player')
      const min = xyz(region.min), max = xyz(region.max)
      const spawnX = Math.floor(playSpawn.x), spawnZ = Math.floor(playSpawn.z)
      this.approach = [spawnX < min[0] ? min[0] : max[0], min[1], spawnZ]
      // The server prepares a three-block clear center strip and these own task
      // pads. Do not let a short diagonal route cut into untouched sand hills.
      this.navigationAllowed = p => {
        const pad = p.x >= min[0] && p.x <= max[0] && p.z >= min[2] && p.z <= max[2] && p.y >= min[1] - 1 && p.y <= max[1]
        const corridor = p.x >= Math.min(spawnX, this.approach[0]) && p.x <= Math.max(spawnX, this.approach[0]) && p.z >= spawnZ - 1 && p.z <= spawnZ + 1 && p.y >= min[1] - 1 && p.y <= min[1] + 1
        const spawn = Math.abs(p.x - spawnX) <= 2 && Math.abs(p.z - spawnZ) <= 2 && p.y >= min[1] - 1 && p.y <= min[1] + 1
        return pad || corridor || spawn
      }
      movements.exclusionAreasStep.push(block => this.navigationAllowed(block.position) ? 0 : Infinity)
      bot.pathfinder.setMovements(movements)
      this.restore = () => bot.pathfinder.setMovements(previous)
    }
  }
  inventory() { return counts(this.bot.inventory.items()) }
  block(position) {
    const block = this.bot.blockAt(new this.Vec3(...position))
    if (!block) throw Error('A task block is not currently loaded; wait near your agent.')
    return block.name
  }
  async moveNear(position, distance = 2) {
    this.check()
    if (this.bot.entity.position.distanceTo(new this.Vec3(...position)) <= distance + 0.5) return
    const min = xyz(this.region.min), max = xyz(this.region.max), current = this.bot.entity.position
    if (this.approach && (current.x < min[0] || current.x > max[0] + 1 || current.z < min[2] || current.z > max[2] + 1)) await this.walk(this.approach, 0)
    return this.walk(position, distance)
  }
  async walk(position, distance, aligned = false) {
    this.check()
    if (!aligned) {
      const p = this.bot.entity.position
      const cell = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
      const dx = Math.sign(position[0] - cell[0]), dz = Math.sign(position[2] - cell[2])
      // A fresh full block can leave the player flush against its corner. The
      // grid solver's first diagonal is then physically impossible from the
      // fractional body pose. Walk one observed-clear cardinal cell first.
      if (dx && dz) for (const step of [[cell[0] + dx, cell[1], cell[2]], [cell[0], cell[1], cell[2] + dz]]) {
        const foot = new this.Vec3(...step)
        if (this.navigationAllowed && !this.navigationAllowed(foot)) continue
        const lower = this.bot.blockAt(foot), upper = this.bot.blockAt(foot.offset(0, 1, 0)), below = this.bot.blockAt(foot.offset(0, -1, 0))
        if (lower?.boundingBox !== 'empty' || upper?.boundingBox !== 'empty' || below?.boundingBox !== 'block') continue
        await this.walk(step, 0, true)
        break
      }
    }
    const p = this.bot.entity.position
    this.lastWalk = { target: [...position], range: distance, from: p.toArray(), physicsEnabled: this.bot.physicsEnabled, physicsTicks: 0,
      health: this.bot.health, food: this.bot.food, isAlive: this.bot.isAlive, usingHeldItem: this.bot.usingHeldItem,
      attributes: this.bot.entity.attributes,
      blocks: [[0, -1, 0], [0, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, -1]].map(([x, y, z]) => {
        const block = this.bot.blockAt(new this.Vec3(Math.floor(p.x) + x, Math.floor(p.y) + y, Math.floor(p.z) + z))
        return { position: block?.position.toArray(), name: block?.name, box: block?.boundingBox, shapes: block?.shapes }
      }), updates: [], ticks: [] }
    const changed = result => {
      if (this.lastWalk.updates.length >= 4) return
      this.lastWalk.updates.push({ status: result.status, visited: result.visitedNodes, generated: result.generatedNodes,
        path: result.path?.slice(0, 10).map(node => ({ x: node.x, y: node.y, z: node.z })) })
      this.onDiagnostic?.(this.lastWalk).catch(() => {})
    }
    this.bot.on('path_update', changed)
    const physical = () => { this.lastWalk.physicsTicks++ }
    this.bot.on('physicsTick', physical)
    await this.onDiagnostic?.(this.lastWalk)
    const observation = setInterval(() => {
      if (this.lastWalk.ticks.length < 4) this.lastWalk.ticks.push({ position: this.bot.entity.position.toArray(),
        controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, this.bot.getControlState(name)])),
        velocity: this.bot.entity.velocity.toArray(), moving: this.bot.pathfinder.isMoving(), onGround: this.bot.entity.onGround })
    }, 500)
    let timeout
    try {
      await Promise.race([
        this.bot.pathfinder.goto(new this.goals.GoalNear(...position, distance)),
        new Promise((_, reject) => { timeout = setTimeout(() => { this.bot.pathfinder.setGoal(null); reject(Error('No safe walking path to the task target.')) }, 20000) })
      ])
    } finally {
      clearTimeout(timeout); clearInterval(observation); this.bot.removeListener('path_update', changed); this.bot.removeListener('physicsTick', physical)
      this.lastWalk.finalPosition = this.bot.entity.position.toArray()
      await this.onDiagnostic?.(this.lastWalk)
    }
    this.check()
  }
  async chest(position, work) {
    if (this.approach && this.bot.entity.position.distanceTo(new this.Vec3(...position)) > 2.5) {
      const min = xyz(this.region.min), max = xyz(this.region.max)
      let current = this.bot.entity.position
      if (current.x < min[0] || current.x > max[0] + 1 || current.z < min[2] || current.z > max[2] + 1) await this.walk(this.approach, 0)
      current = this.bot.entity.position
      // Keep the final chest approach on the prepared north/west strips.
      // A long diagonal from the east of a retained shelter can have a valid
      // grid path while its fractional player body catches the floor corner.
      // First reach the clear north row at the current X, then move west.
      const north = [Math.floor(current.x), min[1], min[2] + 1]
      const west = [min[0] + 1, min[1], min[2] + 1]
      const start = [Math.floor(current.x), min[1], Math.floor(current.z)]
      const clearCardinal = (from, to) => {
        if (from[0] !== to[0] && from[2] !== to[2]) return false
        for (let x = Math.min(from[0], to[0]); x <= Math.max(from[0], to[0]); x++) for (let z = Math.min(from[2], to[2]); z <= Math.max(from[2], to[2]); z++) {
          const point = new this.Vec3(x, min[1], z)
          if (x < min[0] || x > max[0] || z < min[2] || z > max[2] || this.navigationAllowed && !this.navigationAllowed(point) ||
            this.bot.blockAt(point)?.boundingBox !== 'empty' || this.bot.blockAt(new this.Vec3(x, min[1] + 1, z))?.boundingBox !== 'empty' ||
            this.bot.blockAt(new this.Vec3(x, min[1] - 1, z))?.boundingBox !== 'block') return false
        }
        return true
      }
      if (clearCardinal(start, north)) await this.walk(north, 0)
      else {
        // From the retained house's south face, a nominal north path can cut
        // its corner diagonally. The verified east lane separates those axes.
        const east = [max[0] - 1, min[1], start[2]], eastNorth = [max[0] - 1, min[1], north[2]]
        if (!clearCardinal(start, east) || !clearCardinal(east, eastNorth) || !clearCardinal(eastNorth, west)) throw Error('The observed cardinal chest approach is blocked or not loaded. No terrain was changed.')
        await this.walk(east, 0)
        await this.walk(eastNorth, 0)
      }
      await this.walk(west, 0)
    }
    await this.moveNear(position, 2)
    const block = this.bot.blockAt(new this.Vec3(...position))
    if (!block || !['chest', 'trapped_chest'].includes(block.name)) throw Error('The registered chest is missing.')
    const container = await this.bot.openChest(block)
    try { return await work(container) } finally { await container.close() }
  }
  chestCounts(position) { return this.chest(position, async container => counts(container.containerItems())) }
  withdraw(position, item, amount) {
    return this.chest(position, async container => {
      this.check()
      const type = this.bot.registry.itemsByName[item]?.id
      if (!Number.isSafeInteger(type)) throw Error('Unknown Minecraft item.')
      await container.withdraw(type, null, amount)
    })
  }
  deposit(position, item, amount) {
    return this.chest(position, async container => {
      this.check()
      const type = this.bot.registry.itemsByName[item]?.id
      if (!Number.isSafeInteger(type)) throw Error('Unknown Minecraft item.')
      await container.deposit(type, null, amount)
    })
  }
  async craft(item, batches, recipe) {
    const min = xyz(this.region.min), max = xyz(this.region.max), p = this.bot.entity.position
    if (p.x < min[0] || p.x > max[0] + 1 || p.z < min[2] || p.z > max[2] + 1) await this.moveNear([max[0], min[1], max[2]], 0)
    this.check()
    const output = this.bot.registry.itemsByName[item]?.id, ingredient = this.bot.registry.itemsByName[recipe.ingredient]?.id
    if (!Number.isSafeInteger(output) || !Number.isSafeInteger(ingredient)) throw Error('The approved crafting item is absent from this Minecraft registry.')
    const candidate = this.bot.recipesFor(output, null, batches * recipe.output, null).find(value => {
      const changes = value.delta?.filter(entry => entry.count !== 0) || []
      return !value.requiresTable && changes.length === 2 && changes.some(entry => entry.id === output && entry.count === recipe.output) &&
        changes.some(entry => entry.id === ingredient && entry.count === -recipe.input)
    })
    if (!candidate) throw Error('The approved inventory-only recipe is unavailable; no substitute recipe was used.')
    await this.bot.craft(candidate, batches, null)
  }
  async pickup(position) { await this.moveNear(position, 0); this.check(); await pause(200) }
  async gather(position, item) {
    await this.moveNear(position, 2); this.check()
    const block = this.bot.blockAt(new this.Vec3(...position))
    if (!HARVEST.has(item) || block?.name !== item) throw Error('The authorized harvest block changed before digging.')
    if (item === 'sand' && !AIR.has(this.block([position[0], position[1] + 1, position[2]]))) throw Error('Only exposed sand may be harvested; no collapsing column was touched.')
    await this.bot.dig(block, true)
    this.check(); await this.pickup(position)
  }
  async place(position, material) {
    const target = new this.Vec3(...position)
    // Use real standing surfaces around the target. No digging, pillars or
    // temporary blocks are introduced to reach a position.
    let reached = false
    this.lastPlacement = { target: [...position], attempts: [] }
    const min = xyz(this.region.min), max = xyz(this.region.max)
    const offsets = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [3, 0], [-3, 0], [0, 3], [0, -3]]
    // Prefer already walkable ground before trying the top of a newly built
    // platform/wall. All four diagonals are needed when the owner or chests
    // occupy the nearest cardinal standing cells.
    for (let y = min[1]; y <= Math.min(position[1] + 1, max[1]); y++) {
      for (const [dx, dz] of offsets) {
        const feet = [position[0] + dx, y, position[2] + dz]
        if (feet.some((n, i) => n < min[i] || n > max[i])) continue
        const below = this.bot.blockAt(new this.Vec3(feet[0], y - 1, feet[2]))
        const lower = this.bot.blockAt(new this.Vec3(...feet)), upper = this.bot.blockAt(new this.Vec3(feet[0], y + 1, feet[2]))
        if (!below || below.boundingBox !== 'block' || lower?.boundingBox !== 'empty' || upper?.boundingBox !== 'empty') continue
        const occupied = Object.values(this.bot.entities).some(entity => entity !== this.bot.entity &&
          (entity.name === 'player' || entity.username) && Math.abs(entity.position.y - y) < 1.8 &&
          Math.hypot(entity.position.x - (feet[0] + 0.5), entity.position.z - (feet[2] + 0.5)) < 0.8)
        if (occupied) { if (this.lastPlacement.attempts.length < 12) this.lastPlacement.attempts.push({ feet, result: 'occupied_by_player' }); continue }
        const attempt = { feet, from: this.bot.entity.position.toArray() }
        if (this.lastPlacement.attempts.length < 12) this.lastPlacement.attempts.push(attempt)
        try { await this.moveNear(feet, 0); attempt.result = 'reached'; reached = true; break }
        catch (error) { attempt.result = error.message; attempt.walk = this.lastWalk; if (error.code === 'TASK_PAUSED') throw error }
      }
      if (reached) break
    }
    if (!reached) throw Error('No safe standing position for this placement.')
    this.check()
    const item = this.bot.inventory.items().find(item => item.name === material)
    if (!item) throw Error('The agent is missing an approved building item.')
    await this.bot.equip(item, 'hand')
    let reference, face
    for (const [dx, dy, dz] of [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]) {
      if (material === 'oak_log' && dy !== -1) continue
      const block = this.bot.blockAt(target.offset(dx, dy, dz))
      if (block && block.boundingBox === 'block') { reference = block; face = new this.Vec3(-dx, -dy, -dz); break }
    }
    if (!reference) throw Error('A placement has no real supporting reference block.')
    this.check()
    await this.bot.placeBlock(reference, face)
  }
}

export class TaskTools {
  constructor({ rootDirectory, runtimeDirectory, taskRegions = [], adapterFactory, ownerReady, onResult, onTaskLock, playSpawn } = {}) {
    this.root = rootDirectory; this.runtime = runtimeDirectory; this.regions = taskRegions
    this.adapterFactory = adapterFactory; this.ownerReady = ownerReady; this.onResult = onResult; this.onTaskLock = onTaskLock
    this.playSpawn = playSpawn
    this.file = join(runtimeDirectory, 'personal-agent-tasks.json'); this.state = { version: 1, tasks: [] }
    this.writeTail = Promise.resolve(); this.running = new Map(); this.inspecting = new Set()
  }
  async initialize() {
    await mkdir(this.runtime, { recursive: true })
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'))
      if (this.state.version !== 1 || !Array.isArray(this.state.tasks)) throw Error('Task checkpoint is invalid; it was not reset.')
      let changed = false
      for (const inspection of Object.values(this.state.inspections || {})) if (inspection.status === 'inspecting') { inspection.status = 'unlock_required'; changed = true }
      for (const task of this.state.tasks) {
        if (['running', 'finishing'].includes(task.status)) { task.status = 'paused'; task.message = 'Host restarted. Repeat the same request to reconcile and resume.'; changed = true }
        // Normalize a legacy binding only while its original raw hash still
        // matches this exact running server's declared terms. Never overwrite
        // the historical hash or guess across a changed origin/chest/region.
        const region = this.regions.find(value => value.slotName === task.slotName)
        if (task.hashVersion !== 2 && !task.canonicalPlanHash && region &&
            (!region.ownerId || region.ownerId.toLowerCase() === task.ownerId) &&
            rawHash({ plan: task.plan, region }) === task.planHash) {
          task.canonicalPlanHash = hash({ plan: task.plan, region })
          task.bindingMigration = { fromRawHash: task.planHash, canonicalHash: task.canonicalPlanHash, verifiedAt: new Date().toISOString() }
          changed = true
        }
      }
      if (changed) await this.save()
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return this
  }
  save() {
    const write = this.writeTail.then(async () => {
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(this.state, null, 2) + '\n'); await file.sync() } finally { await file.close() }
      await rename(temporary, this.file)
      if (process.platform !== 'win32') { const directory = await open(this.runtime, 'r'); try { await directory.sync() } finally { await directory.close() } }
    })
    this.writeTail = write.catch(() => {})
    return write
  }
  status(ownerId) {
    return this.state.tasks.filter(task => !ownerId || task.ownerId === ownerId).map(task => ({
      id: task.id, ownerId: task.ownerId, slotName: task.slotName, action: task.plan.action,
      status: task.status, completed: task.completed.length, total: task.plan.placements?.length ?? 1,
      message: task.message, operationId: task.operationId
    }))
  }
  unfinished(ownerId) { return this.state.tasks.find(task => task.ownerId === ownerId && ACTIVE.has(task.status)) }
  async cancelZeroEffect(slot, operationId) {
    this.region(slot)
    const task = this.unfinished(slot.ownerId)
    if (this.inspecting.has(slot.ownerId) || this.state.inspections?.[slot.ownerId]?.status === 'unlock_required') throw Error('Finish the protected supplies inspection before cancelling.')
    if (task && (task.slotName !== slot.name || this.running.has(task.id) || task.pending || task.status === 'reconciliation_required')) throw Error('Cancellation is waiting for the native operation or protected lock to be reconciled. Keep the same task and materials.')
    if (task && (Object.keys(task.receipts || {}).length || task.completed?.length || task.withdrawn || task.delivered)) throw Error('This task has material or block receipts. Resume it or ask the operator to reconcile its materials; it cannot be discarded.')
    if (typeof slot.bot?.inventory?.items !== 'function' || slot.bot.inventory.items().some(item => item?.count > 0) || slot.bot.inventory.slots?.some(item => item?.count > 0) || slot.bot.currentWindow?.selectedItem?.count > 0) throw Error('Cancellation requires a verified empty agent inventory; carried materials must be reconciled first.')
    if (task) {
      // Even a zero-effect failure must confirm that its own native lock is gone.
      if (this.onTaskLock) await this.onTaskLock(slot, task, { locked: false })
      task.status = 'cancelled'; task.cancelledAt = new Date().toISOString(); task.cancellationOperationId = operationId
      task.message = 'Explicitly cancelled by the owner before any native material or block effects. Original task terms and receipts retained.'
      await this.save()
    }
    return task || null
  }
  region(slot) {
    const region = this.regions.find(region => region.slotName === slot.name)
    if (!region || region.ownerId && region.ownerId.toLowerCase() !== slot.ownerId) throw Error('This agent has no authorized task plot.')
    return region
  }
  capabilities() {
    return { structures: { action: 'build_structure', maxBlocks: 256, maxHeight: 6, width: 8, depth: 8, materials: [...MATERIALS], procedural: ['house', 'tower', 'bridge', 'wall', 'stairs', 'arch'] },
      gather: { items: [...HARVEST], maxCount: 16, registeredOwnPlotOnly: true, protectsRecordedStructures: true },
      craft: { ...RECIPES }, materialSources: ['carried_inventory', 'registered_source_chest', 'safe_inventory_recipes'] }
  }
  async inspect(slot) {
    const region = this.region(slot), unfinished = this.unfinished(slot.ownerId)
    if (this.inspecting.has(slot.ownerId) || unfinished?.pending || unfinished && this.running.has(unfinished.id)) throw Error('Wait for the current native operation before inspecting material stock.')
    const generation = slot.generation, check = () => {
      if (!slot.bot || generation !== slot.generation || this.ownerReady && !this.ownerReady(slot)) throw Error('Join your own play area before inspecting your agent materials.')
    }
    check(); this.inspecting.add(slot.ownerId)
    this.state.inspections ??= {}
    let inspection = this.state.inspections[slot.ownerId], locked = false, adapter, created = false
    try {
      if (inspection && inspection.status !== 'complete' && this.onTaskLock) await this.onTaskLock(slot, inspection, { locked: false })
      inspection = { id: randomUUID(), ownerId: slot.ownerId, slotName: slot.name, status: 'inspecting' }
      created = true
      this.state.inspections[slot.ownerId] = inspection; await this.save()
      if (this.onTaskLock) { locked = true; await this.onTaskLock(slot, inspection, { locked: true }) }
      adapter = this.adapterFactory ? await this.adapterFactory(slot, region, check) : new NativeTaskAdapter({ bot: slot.bot, rootDirectory: this.root, region, check, playSpawn: this.playSpawn })
      check()
      const source = await adapter.chestCounts(region.sourceChest), destination = await adapter.chestCounts(region.destinationChest)
      check()
      const min = xyz(region.min), max = xyz(region.max), protectedCells = new Set([...this.state.tasks.filter(task => task.slotName === slot.name).flatMap(task => (task.plan.placements || []).map(placement => key(placement.position))), key(region.sourceChest), key(region.destinationChest)])
      const resources = []
      for (let y = max[1]; y >= min[1] && resources.length < 16; y--) for (let x = min[0] + 2; x <= max[0] && resources.length < 16; x++) for (let z = min[2] + 2; z <= max[2] && resources.length < 16; z++) {
        const position = [x, y, z], item = adapter.block(position)
        if (!protectedCells.has(key(position)) && HARVEST.has(item) && (item !== 'sand' || AIR.has(adapter.block([x, y + 1, z])))) resources.push({ item, offset: position.map((n, i) => n - region.origin[i]) })
      }
      inspection.snapshot = { observedAt: new Date().toISOString(), inventory: adapter.inventory(), source, destination, resources,
        bounds: { min, max, origin: [...region.origin] }, capabilities: this.capabilities(), recordedStructures: this.state.tasks.filter(task => task.slotName === slot.name && task.plan.placements).map(task => ({ taskId: task.id, status: task.status, blocks: task.plan.placements.length })) }
      return inspection.snapshot
    } finally {
      try {
      adapter?.restore?.()
      if (created) {
        inspection.status = 'unlock_required'; await this.save()
        if (locked && this.onTaskLock) await this.onTaskLock(slot, inspection, { locked: false })
        inspection.status = 'complete'; await this.save()
      }
      } finally { this.inspecting.delete(slot.ownerId) }
    }
  }
  async start({ slot, plan: input, operationId }) {
    if (this.inspecting.has(slot.ownerId) || this.state.inspections?.[slot.ownerId]?.status === 'unlock_required') throw Error('Finish or reconcile the short material inspection lock before starting a task.')
    const region = this.region(slot), plan = compileTaskPlan(input, region), planHash = hash({ plan, region })
    let task = this.state.tasks.find(task => task.operationId === operationId)
    const matches = value => (value.hashVersion === 2 ? value.planHash : value.canonicalPlanHash) === planHash ||
      value.hashVersion !== 2 && !value.canonicalPlanHash && value.planHash === rawHash({ plan, region })
    if (task && (task.ownerId !== slot.ownerId || task.slotName !== slot.name || !matches(task))) throw Error('This task request ID has different terms.')
    task ??= this.unfinished(slot.ownerId)
    if (task && (task.slotName !== slot.name || !matches(task))) throw Error('Your previous physical task must finish or be reconciled before a different task starts.')
    if (task?.status === 'complete') return `Task ${task.id} is already complete; no materials moved again.`
    if (task?.status === 'cancelled') return `Task ${task.id} was cancelled; this old request cannot restart it. Submit a new request to authorize new work.`
    if (!task) {
      task = { id: randomUUID(), operationId, ownerId: slot.ownerId, ownerName: slot.ownerName, slotName: slot.name,
        plan, planHash, hashVersion: 2, status: 'paused', completed: [], preexisting: [], receipts: {}, pending: null, withdrawn: false, delivered: false,
        createdAt: new Date().toISOString(), message: 'Task accepted; checking real stock and blocks.' }
      this.state.tasks.push(task)
      await this.save()
    }
    if (this.running.has(task.id)) return `Task ${task.id} is running: ${task.completed.length}/${plan.placements?.length ?? 1}.`
    const generation = slot.generation
    const check = () => {
      if (slot.generation !== generation || !slot.bot || this.ownerReady && !this.ownerReady(slot)) {
        const error = Error('Task paused. Rejoin your play area and repeat the same request to resume.'); error.code = 'TASK_PAUSED'; throw error
      }
    }
    check()
    const adapter = this.adapterFactory ? await this.adapterFactory(slot, region, check) : new NativeTaskAdapter({ bot: slot.bot, rootDirectory: this.root, region, check, playSpawn: this.playSpawn,
      onDiagnostic: value => { task.lastNavigation = value; return this.save() } })
    slot.mode = 'task'; task.status = 'running'; task.message = 'Checking real stock and observed blocks.'
    await this.save()
    let locked = false
    const work = (async () => {
      if (this.onTaskLock) { await this.onTaskLock(slot, task, { locked: true }); locked = true }
      await this.run(task, adapter, check)
    })().then(() => {
      task.status = 'finishing'; task.message = plan.action === 'deliver' ? `Delivered ${plan.count} ${plan.item} into your destination chest.` : plan.action === 'collect' ? `Collected ${plan.count} ${plan.item} from your source chest into your agent's real inventory.` : plan.action === 'craft' ? `Crafted ${plan.outputCount} ${plan.item} from consumed real ingredients.` : plan.action === 'gather' ? `Harvested and picked up ${plan.count} ${plan.item} from your authorized plot.` : `Built and checked ${description(plan)} with ${task.completed.length - task.preexisting.length} real placements.`
    }).catch(error => {
      task.status = task.pending ? 'reconciliation_required' : error.code === 'TASK_PAUSED' ? 'paused' : 'blocked'
      task.message = error.message
      if (adapter.lastPlacement) task.lastPlacement = adapter.lastPlacement
    }).finally(async () => {
      if (slot.mode === 'task') slot.mode = 'wait'
      adapter.restore?.()
      // A native operation with an unknown outcome keeps the plot and material
      // chests locked. Only same-task reconciliation may release that lock.
      if (locked && !task.pending && this.onTaskLock) {
        try { await this.onTaskLock(slot, task, { locked: false }) }
        catch { task.status = 'reconciliation_required'; task.message = 'Task effects were observed, but releasing its protected plot lock still needs reconciliation.' }
      }
      if (task.status === 'finishing') task.status = 'complete'
      await this.save()
      this.running.delete(task.id)
      await this.onResult?.(slot, task.message)
    })
    this.running.set(task.id, work)
    return `Task ${task.id} started: ${['deliver', 'collect'].includes(plan.action) ? `${plan.action} ${plan.count} ${plan.item}` : description(plan)}. Use /agent status or /agent wait.`
  }
  async snapshot(adapter, intent) {
    const value = { inventory: adapter.inventory() }
    if (['place', 'gather'].includes(intent.kind)) value.block = adapter.block(intent.position)
    else if (intent.kind !== 'craft') value.chest = await adapter.chestCounts(intent.position)
    return value
  }
  async matches(adapter, intent, expected) {
    const actual = await this.snapshot(adapter, intent)
    return equal(actual.inventory, expected.inventory) &&
      (['place', 'gather'].includes(intent.kind) ? actual.block === expected.block : intent.kind === 'craft' || equal(actual.chest, expected.chest))
  }
  async effect(task, adapter, check, intent, perform) {
    task.receipts ??= {}
    if (task.receipts[intent.id]) return
    if (task.pending && task.pending.id !== intent.id) throw Error('The original material operation still needs reconciliation.')
    if (!task.pending) {
      check()
      intent.before = await this.snapshot(adapter, intent)
      intent.after = intent.kind === 'craft' ? { inventory: delta(delta(intent.before.inventory, intent.recipe.ingredient, -intent.recipe.input * intent.batches), intent.item, intent.recipe.output * intent.batches) }
        : intent.kind === 'gather' ? { inventory: delta(intent.before.inventory, intent.item, 1), block: 'air' }
        : intent.kind === 'place'
        ? { inventory: delta(intent.before.inventory, intent.item, -1), block: intent.item }
        : { inventory: delta(intent.before.inventory, intent.item, intent.kind === 'withdraw' ? intent.count : -intent.count),
            chest: delta(intent.before.chest, intent.item, intent.kind === 'withdraw' ? -intent.count : intent.count) }
      const available = intent.kind === 'place' ? intent.before.inventory[intent.item] : intent.before.chest?.[intent.item]
      if (['place', 'withdraw'].includes(intent.kind) && (available || 0) < (intent.kind === 'place' ? 1 : intent.count)) throw Error('Material shortage. Add the required real items to your registered source chest, then repeat the same task.')
      if (intent.kind === 'craft' && (intent.before.inventory[intent.recipe.ingredient] || 0) < intent.recipe.input * intent.batches) throw Error('Actual crafting ingredients are missing; no output was created.')
      if (intent.kind === 'gather' && intent.before.block !== intent.item) throw Error('The authorized resource block changed; no substitute cell was dug.')
      if (intent.kind === 'deposit' && (intent.before.inventory[intent.item] || 0) < intent.count) throw Error('Delivery cargo is missing; operator material reconciliation is required.')
      if (intent.kind === 'place' && !['air', 'cave_air', 'void_air'].includes(intent.before.block)) throw Error('A build target changed; no existing block was overwritten.')
      task.pending = intent; await this.save()
    }
    intent = task.pending
    const confirm = async () => {
      task.receipts[intent.id] = { before: intent.before, after: intent.after, observedAt: new Date().toISOString(),
        ...(intent.kind === 'place' && adapter.lastPlacement ? { navigation: adapter.lastPlacement } : {}) }
      task.pending = null
      await this.save()
    }
    if (await this.matches(adapter, intent, intent.after)) { await confirm(); return }
    if (intent.kind === 'gather' && AIR.has(adapter.block(intent.position)) && equal(adapter.inventory(), intent.before.inventory) && adapter.pickup) {
      check(); await adapter.pickup(intent.position)
      if (await this.matches(adapter, intent, intent.after)) { await confirm(); return }
    }
    if (!await this.matches(adapter, intent, intent.before)) throw Error('Observed blocks or item counts differ from the recorded operation. Operator material reconciliation is required.')
    check()
    await perform(intent)
    for (let i = 0; i < 40; i++) {
      if (await this.matches(adapter, intent, intent.after)) { await confirm(); return }
      await pause(100)
    }
    throw Error('Native operation reply is uncertain. Repeat the same task to reconcile; do not move its materials.')
  }
  async supply(task, adapter, check, needs) {
    if (!task.supplyPlans) {
      const inventory = { ...adapter.inventory() }, shortage = {}, steps = []
      for (const [item, amount] of Object.entries(needs).sort()) {
        const carried = Math.min(inventory[item] || 0, amount)
        inventory[item] = (inventory[item] || 0) - carried
        shortage[item] = amount - carried
      }
      const chest = Object.values(shortage).some(Boolean) ? { ...await adapter.chestCounts(task.plan.source) } : {}
      for (const item of Object.keys(shortage)) {
        const take = Math.min(chest[item] || 0, shortage[item])
        if (take) { steps.push({ kind: 'withdraw', item, count: take, position: task.plan.source }); chest[item] -= take; shortage[item] -= take }
      }
      for (const [item, missing] of Object.entries(shortage)) if (missing) {
        const recipe = RECIPES[item]
        if (!recipe || item === 'stick') throw Error(`Material shortage: need ${missing} more ${item} in carried inventory or your source chest.`)
        const batches = Math.ceil(missing / recipe.output), needed = batches * recipe.input
        const carried = Math.min(inventory[recipe.ingredient] || 0, needed), take = needed - carried
        if ((chest[recipe.ingredient] || 0) < take) throw Error(`Material shortage: need ${missing} ${item}, or ${needed} ${recipe.ingredient} for its safe inventory recipe.`)
        inventory[recipe.ingredient] = (inventory[recipe.ingredient] || 0) - carried
        if (take) { steps.push({ kind: 'withdraw', item: recipe.ingredient, count: take, position: task.plan.source }); chest[recipe.ingredient] -= take }
        steps.push({ kind: 'craft', item, batches, recipe: { ...recipe } })
      }
      task.supplyPlans = steps; await this.save()
    }
    for (let index = 0; index < task.supplyPlans.length; index++) {
      const step = task.supplyPlans[index], intent = { ...step, id: task.operationId + ':supply:' + index }
      await this.effect(task, adapter, check, intent, value => value.kind === 'craft' ? adapter.craft(value.item, value.batches, value.recipe) : adapter.withdraw(value.position, value.item, value.count))
    }
  }
  async run(task, adapter, check) {
    const plan = task.plan
    const clearancesEmpty = () => {
      if (plan.clearances?.some(position => !AIR.has(adapter.block(position)))) throw Error('A declared structure opening is occupied. No existing block was removed and no opening was claimed clear.')
    }
    if (plan.action === 'craft') {
      await this.supply(task, adapter, check, { [plan.recipe.ingredient]: plan.recipe.input * plan.batches })
      await this.effect(task, adapter, check, { id: task.operationId + ':craft', kind: 'craft', item: plan.item, batches: plan.batches, recipe: plan.recipe }, intent => adapter.craft(intent.item, intent.batches, intent.recipe))
      task.completed = ['craft']; await this.save(); return
    }
    if (plan.action === 'gather') {
      if (!task.gatherPositions) {
        const protectedCells = new Set([...this.state.tasks.filter(value => value.slotName === task.slotName && value.id !== task.id)
          .flatMap(value => (value.plan.placements || []).map(placement => key(placement.position))), key(this.regions.find(region => region.slotName === task.slotName).sourceChest), key(this.regions.find(region => region.slotName === task.slotName).destinationChest)])
        let candidates = plan.positions
        if (!candidates) {
          candidates = []
          for (let y = plan.bounds.max[1]; y >= plan.bounds.min[1]; y--) for (let x = plan.bounds.min[0] + 2; x <= plan.bounds.max[0]; x++) for (let z = plan.bounds.min[2] + 2; z <= plan.bounds.max[2]; z++) candidates.push([x, y, z])
        }
        task.gatherPositions = candidates.filter(position => !protectedCells.has(key(position)) && adapter.block(position) === plan.item &&
          (plan.item !== 'sand' || AIR.has(adapter.block([position[0], position[1] + 1, position[2]])))).slice(0, plan.count)
        if (task.gatherPositions.length < plan.count) { delete task.gatherPositions; throw Error('Not enough safe observed resources in your plot. Existing recorded structures, task chests, access strips and foundations are protected.') }
        await this.save()
      }
      for (let index = 0; index < task.gatherPositions.length; index++) {
        if (task.completed.includes(index)) continue
        await this.effect(task, adapter, check, { id: task.operationId + ':gather:' + index, kind: 'gather', item: plan.item, position: task.gatherPositions[index], count: 1 }, intent => adapter.gather(intent.position, intent.item))
        task.completed.push(index); await this.save()
      }
      return
    }
    if (['deliver', 'collect'].includes(plan.action)) {
      if (!task.withdrawn) {
        if (task.deliveryWithdrawCount === undefined) {
          task.deliveryWithdrawCount = plan.action === 'collect' || task.pending?.id === task.operationId + ':withdraw' || task.receipts[task.operationId + ':withdraw']
            ? plan.count : Math.max(0, plan.count - (adapter.inventory()[plan.item] || 0))
          await this.save()
        }
        if (task.deliveryWithdrawCount) await this.effect(task, adapter, check, { id: task.operationId + ':withdraw', kind: 'withdraw', position: plan.source, item: plan.item, count: task.deliveryWithdrawCount }, intent => adapter.withdraw(intent.position, intent.item, intent.count))
        task.withdrawn = true; await this.save()
      }
      if (plan.action === 'collect') { task.completed = ['collection']; await this.save(); return }
      if (!task.delivered) {
        await this.effect(task, adapter, check, { id: task.operationId + ':deposit', kind: 'deposit', position: plan.destination, item: plan.item, count: plan.count }, intent => adapter.deposit(intent.position, intent.item, intent.count))
        task.delivered = true; task.completed = ['delivery']; await this.save()
      }
      return
    }
    clearancesEmpty()
    if (!task.withdrawn) {
      check()
      if (!task.scanComplete) {
        let missing = 0; const needs = {}
        for (let i = 0; i < plan.placements.length; i++) {
          const block = adapter.block(plan.placements[i].position)
          const material = plan.placements[i].material
          if (block === material) { task.completed.push(i); task.preexisting.push(i) }
          else if (AIR.has(block)) { missing++; needs[material] = (needs[material] || 0) + 1 }
          else throw Error('The build footprint is obstructed. No existing blocks were removed.')
        }
        task.scanComplete = true; task.materialCount = missing; task.materialNeeds = needs
        await this.save()
      }
      if (task.pending?.id === task.operationId + ':withdraw' || task.receipts[task.operationId + ':withdraw']) {
        await this.effect(task, adapter, check, { id: task.operationId + ':withdraw', kind: 'withdraw', position: plan.source, item: plan.material, count: task.materialCount }, intent => adapter.withdraw(intent.position, intent.item, intent.count))
      } else if (task.materialCount) await this.supply(task, adapter, check, task.materialNeeds || { [plan.material]: task.materialCount })
      task.withdrawn = true; await this.save()
    }
    for (let i = 0; i < plan.placements.length; i++) {
      if (task.completed.includes(i)) continue
      check()
      await this.effect(task, adapter, check, { id: task.operationId + ':place:' + i, kind: 'place', position: plan.placements[i].position, item: plan.placements[i].material, count: 1 }, intent => adapter.place(intent.position, intent.item))
      task.completed.push(i); await this.save()
      task.message = `Placed ${task.completed.length}/${plan.placements.length} blocks.`
    }
    if (plan.placements.some(placement => adapter.block(placement.position) !== placement.material)) throw Error('The finished structure changed before its final real-block check.')
    clearancesEmpty()
  }
  async idle() { await Promise.all([...this.running.values()]); await this.writeTail }
}

export async function createTaskTools(options) { return new TaskTools(options).initialize() }
