import { createRequire } from 'node:module'
import { join } from 'node:path'
import {readFile} from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { compileTaskPlan, NativeTaskAdapter } from './task-tools.mjs'

const require = createRequire(import.meta.url)
const empty = new Set(['air', 'cave_air', 'void_air'])
const food = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'apple', 'carrot', 'melon_slice', 'beef', 'porkchop', 'mutton']
const resources = ['oak_log', 'birch_log', 'spruce_log', 'stone', 'coal_ore', 'iron_ore', 'copper_ore', 'redstone_ore', 'diamond_ore', 'dirt', 'sand', 'wheat', 'carrots', 'potatoes', 'beetroots', 'crafting_table', 'furnace', 'chest', 'redstone_lamp', 'lever']
const aliases = { cobblestone: ['stone', 'cobblestone'], coal: ['coal_ore', 'deepslate_coal_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], redstone: ['redstone_ore', 'deepslate_redstone_ore'], diamond: ['diamond_ore', 'deepslate_diamond_ore'], carrot: ['carrots'], potato: ['potatoes'] }
const placed = { redstone: ['redstone_wire'], redstone_torch: ['redstone_torch', 'redstone_wall_torch'], torch: ['torch', 'wall_torch'] }
const allowed = {
  move: ['position'], gather: ['item', 'count'], craft: ['item', 'count'],
  build: ['structure', 'width', 'depth', 'height', 'item', 'position'],
  place: ['item', 'position'], activate: ['position'], equip: ['item', 'destination'],
  eat: [], smelt: ['item', 'count', 'fuel', 'position'], hunt: ['animal', 'count'],
  deposit: ['item', 'count', 'position'], withdraw: ['item', 'count', 'position'], observe: [], purchase:['item','count'], blueprint:[]
}
export const survivalSkills = Object.freeze({
  move: 'Walk to an observed reachable absolute [x,y,z]; no path digging or free scaffolding.',
  gather: 'Find and harvest up to 32 nearby blocks of item; use real tools and collect actual drops. Prefer natural resources; never dismantle a building for materials.',
  craft: 'Craft desired output count with an actual available vanilla recipe, using a nearby crafting table when required.',
  build: 'Build house/tower/bridge/wall/stairs/arch, width/depth <=8, height <=6, using carried blocks. Position is its absolute bottom corner; default is the assigned work plot.',
  place: 'Place one carried block or redstone component at an empty absolute position; inspect actual resulting block state.',
  activate: 'Activate an observed lever, button, door or other usable block; inspect its actual state afterward.',
  equip: 'Equip a carried item in hand/off-hand/head/torso/legs/feet.',
  eat: 'Eat real carried food when hungry.',
  smelt: 'Cook or smelt count <=16 input using carried fuel in an empty observed furnace; collect real output.',
  hunt: 'Hunt a nearby cow/pig/chicken/sheep/rabbit for real drops. Never attack players, agents, villagers or pets.',
  deposit: 'Deposit carried items into an observed chest.',
  withdraw: 'Withdraw materials only from this agent’s registered source chest.',
  purchase: 'Request up to 32 stocked shop materials for this objective. Backend checks standing owner consent and spends existing testnet CITY/gas only; no funding, swaps or wallet selection. Wait for actual delivery. Prefer available source supplies or gathering before buying.',
  blueprint: 'Read the pinned 144-block calculator material bill and relative placements. Planning data only; placement orientation and a working circuit still require real verification.',
  observe: 'Read health, hunger, inventory, surroundings, recipes and nearby entities. No effects or financial permissions.'
})
export function validateSurvivalTool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(allowed, value.tool) || Object.keys(value).some(k => k !== 'tool' && !allowed[value.tool].includes(k))) throw Error('INVALID_SURVIVAL_TOOL')
  for (const key of ['item', 'fuel']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value[key]))) throw Error('INVALID_SURVIVAL_ITEM')
  if (['purchase','gather', 'craft', 'deposit', 'withdraw', 'smelt', 'equip', 'place', 'build'].includes(value.tool) && !value.item) throw Error('SURVIVAL_ITEM_REQUIRED')
  if (['purchase','gather', 'craft', 'deposit', 'withdraw', 'smelt'].includes(value.tool) && (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > (value.tool === 'smelt' ? 16 : 32))) throw Error('INVALID_SURVIVAL_COUNT')
  if (value.position !== undefined && (!Array.isArray(value.position) || value.position.length !== 3 || !value.position.every(Number.isSafeInteger))) throw Error('INVALID_SURVIVAL_POSITION')
  if (['move', 'place', 'activate', 'deposit', 'withdraw', 'smelt'].includes(value.tool) && !value.position) throw Error('SURVIVAL_POSITION_REQUIRED')
  if (value.tool === 'build' && (!['house', 'tower', 'bridge', 'wall', 'stairs', 'arch'].includes(value.structure) || ![value.width, value.depth, value.height].every((n, i) => Number.isSafeInteger(n) && n >= 1 && n <= (i === 2 ? 6 : 8)))) throw Error('INVALID_SURVIVAL_BUILD')
  if (value.tool === 'equip' && !['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(value.destination)) throw Error('INVALID_EQUIP_DESTINATION')
  if (value.tool === 'hunt' && (!['cow', 'pig', 'chicken', 'sheep', 'rabbit'].includes(value.animal) || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 4)) throw Error('INVALID_HUNT_TARGET')
  return structuredClone(value)
}
const inventory = bot => Object.fromEntries(bot.inventory.items().reduce((m, x) => m.set(x.name, (m.get(x.name) || 0) + x.count), new Map()))
const xyz = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
export class SurvivalTools {
  constructor({ rootDirectory, manager, slot, world, guard, beforeEffect, receipt }) {
    Object.assign(this, { rootDirectory, manager, slot, world, guard, beforeEffect, receipt })
    const dependencies = join(rootDirectory, 'tests/compatibility/node_modules')
    this.Vec3 = require(join(dependencies, 'vec3')).Vec3
    const pf = require(join(dependencies, 'mineflayer-pathfinder'))
    this.Movements = pf.Movements
  }
  get bot() { return this.slot.bot }
  point(position) {
    const bounds = this.world.mumbaiAgentBounds
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isSafeInteger) || position.some((n, i) => n < bounds.min[['x', 'y', 'z'][i]] || n > bounds.max[['x', 'y', 'z'][i]])) throw Error('OUTSIDE_MUMBAI_SURVIVAL_BOUNDS')
    return new this.Vec3(...position)
  }
  block(position) { const b = this.bot.blockAt(this.point(position)); if (!b) throw Error('BLOCK_NOT_LOADED'); return b }
  async observe() {
    await this.guard()
    const bot = this.bot, nearby = []
    for (const name of resources) {
      const id = bot.registry.blocksByName[name]?.id
      if (id === undefined) continue
      const positions = bot.findBlocks({ matching: id, maxDistance: 24, count: 2 })
      for (const p of positions) { const b = bot.blockAt(p); if (b) nearby.push({ name, position: xyz(p), properties: b.getProperties() }) }
    }
    return { observedAt: new Date().toISOString(), position: xyz(bot.entity.position), health: bot.health, hunger: bot.food,
      inventory: inventory(bot), heldItem: bot.heldItem?.name || null, nearby,
      entities: Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= 24).slice(0, 12).map(e => ({ name: e.name || e.username, position: xyz(e.position) })),
      buildPlot: this.manager.taskRegions.find(r => r.slotName === this.slot.name),
      crafting: ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'bread', 'lever', 'redstone_torch', 'redstone_lamp'].filter(n => bot.registry.itemsByName[n] && bot.recipesFor(bot.registry.itemsByName[n].id, null, 1, null).length > 0) }
  }
  async move(position, distance = 2) {
    const target = this.point(position); await this.guard()
    if (target.distanceTo(this.bot.entity.position) > 64) throw Error('MOVE_AT_MOST_64_BLOCKS_PER_STEP')
    const previous = this.bot.pathfinder.movements, movements = new this.Movements(this.bot)
    movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.getMoveDiagonal = () => {}; movements.scafoldingBlocks = []; movements.maxDropDown = this.bot.health >= 10 ? 4 : 1
    this.bot.pathfinder.setMovements(movements)
    try {
      const walking=new NativeTaskAdapter({bot:this.bot,rootDirectory:this.rootDirectory,region:this.world.mumbaiAgentBounds,check:()=>{if(this.cancelled?.())throw Error('OBJECTIVE_STOPPED')},onDiagnostic:async details=>{this.lastNavigation=details}})
      await walking.walk(position,distance)
      await this.guard()
      if (target.distanceTo(this.bot.entity.position) > distance + 1.5) throw Error('DESTINATION_NOT_REACHED')
      return { position: xyz(this.bot.entity.position) }
    } finally { this.bot.pathfinder.setMovements(previous) }
  }
  async effect(details, run, verify) {
    await this.guard(); await this.beforeEffect({ ...details, inventoryBefore: inventory(this.bot) })
    const applied = await run(); await this.guard()
    const deadline=Date.now()+3000
    let result
    while(true){
      try{result=await verify(applied);break}catch(error){
        if(!/RECEIPT_UNCERTAIN$/.test(error.message)||Date.now()>=deadline)throw error
        await this.guard();await pause(100)
      }
    }
    await this.receipt({ ...details, result, inventoryAfter: inventory(this.bot) })
    return result
  }
  async place(position, item) {
    const b = this.block(position), names = placed[item] || [item]
    if (names.includes(b.name)) return { existing: true, block: b.name, position }
    if (!empty.has(b.name)) throw Error('BUILD_TARGET_OCCUPIED: ' + b.name)
    const carried = this.bot.inventory.items().find(x => x.name === item)
    if (!carried) throw Error('MISSING_CARRIED_ITEM: ' + item)
    await this.move(position, 3)
    await this.bot.equip(carried, 'hand')
    let reference, face
    for (const [dx, dy, dz] of [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]) {
      const block = this.bot.blockAt(this.point(position).offset(dx, dy, dz))
      if (block?.boundingBox === 'block') { reference = block; face = new this.Vec3(-dx, -dy, -dz); break }
    }
    if (!reference) throw Error('NO_SUPPORTING_BLOCK')
    const before = inventory(this.bot)[item] || 0
    return this.effect({ action: 'place', item, position }, () => this.bot.placeBlock(reference, face), () => {
      const after = this.block(position)
      if (!names.includes(after.name) || (inventory(this.bot)[item] || 0) !== before - 1) throw Error('PLACEMENT_RECEIPT_UNCERTAIN')
      return { block: after.name, properties: after.getProperties(), position, consumed: 1 }
    })
  }
  async execute(raw) {
    const step = validateSurvivalTool(raw); await this.guard()
    const bot = this.bot, count = () => inventory(bot)[step.item] || 0
    if(step.tool==='blueprint'){
      const blueprint=JSON.parse(await readFile(join(this.rootDirectory,'fixtures/blueprints/calculator-v1.json'),'utf8'))
      return{id:blueprint.id,bounds:blueprint.bounds,materialBill:blueprint.material_bill,placements:blueprint.placements,
        message:'Relative coordinates and required block states; this does not construct or verify a circuit.'}
    }
    if (step.tool === 'observe') return this.observe()
    if (step.tool === 'move') return this.move(step.position)
    if (step.tool === 'place') return this.place(step.position, step.item)
    if (step.tool === 'equip') {
      const item = bot.inventory.items().find(x => x.name === step.item); if (!item) throw Error('ITEM_NOT_CARRIED')
      await bot.equip(item, step.destination); return { equipped: step.item, destination: step.destination }
    }
    if (step.tool === 'eat') {
      if (bot.food >= 20) return { hunger: bot.food, needed: false }
      const item = food.map(n => bot.inventory.items().find(x => x.name === n)).find(Boolean); if (!item) throw Error('NO_CARRIED_FOOD')
      await bot.equip(item, 'hand')
      return this.effect({ action: 'eat', item: item.name }, () => bot.consume(), () => ({ hunger: bot.food, health: bot.health }))
    }
    if (step.tool === 'gather') {
      const candidates = aliases[step.item] || [step.item]
      if (!candidates.every(n => /^(?:oak_log|birch_log|spruce_log|stone|cobblestone|dirt|sand|gravel|coal_ore|iron_ore|copper_ore|redstone_ore|diamond_ore|deepslate_[a-z_]+_ore|wheat|carrots|potatoes|beetroots)$/.test(n))) throw Error('GATHER_NATURAL_RESOURCES_ONLY')
      const before = count()
      for (let i = 0; i < 32 && count() - before < step.count; i++) {
        const ids = candidates.map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
        const positions = bot.findBlocks({ matching: ids, maxDistance: 24, count: 16 })
        const position = positions.find(p => { const b = bot.blockAt(p), age = b?.getProperties()?.age; return age === undefined || Number(age) >= (b.name === 'beetroots' ? 3 : 7) })
        if (!position) { if (count() > before) break; throw Error('RESOURCE_NOT_OBSERVED: ' + step.item) }
        await this.move(xyz(position), 2)
        const block = bot.blockAt(position)
        const tools = bot.inventory.items().filter(x => block.canHarvest(x.type)).sort((a, b) => block.digTime(a.type, false, false, false, [], {}) - block.digTime(b.type, false, false, false, [], {}))
        if (tools[0]) await bot.equip(tools[0], 'hand')
        if (!block.canHarvest(bot.heldItem?.type ?? null)) throw Error('SUITABLE_HARVEST_TOOL_REQUIRED')
        await this.effect({ action: 'dig', item: step.item, position: xyz(position), blockBefore: block.name }, () => bot.dig(block, true), () => {
          if (bot.blockAt(position)?.type === block.type) throw Error('DIG_NOT_APPLIED')
          return { removed: block.name, position: xyz(position) }
        })
        await this.move(xyz(position), 0); await pause(400)
      }
      if (count() <= before) throw Error('NO_RESOURCE_COLLECTED')
      return { item: step.item, collected: count() - before, requested: step.count, inventory: inventory(bot) }
    }
    if (step.tool === 'craft') {
      const item = bot.registry.itemsByName[step.item]; if (!item) throw Error('UNKNOWN_RECIPE_ITEM')
      let table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 24 })
      let recipes = bot.recipesFor(item.id, null, 1, null)
      if (!recipes.length && table) { await this.move(xyz(table.position), 2); recipes = bot.recipesFor(item.id, null, 1, table) }
      const recipe = recipes[0]; if (!recipe) throw Error('RECIPE_NEEDS_MATERIALS_OR_CRAFTING_TABLE')
      const batches = Math.ceil(step.count / recipe.result.count), output = batches * recipe.result.count
      if (!bot.recipesFor(item.id, null, output, recipe.requiresTable ? table : null).length) throw Error('INSUFFICIENT_RECIPE_INGREDIENTS')
      const before = count()
      return this.effect({ action: 'craft', item: step.item, batches, output }, () => bot.craft(recipe, batches, recipe.requiresTable ? table : null), () => {
        if (count() - before !== output) throw Error('CRAFT_RECEIPT_UNCERTAIN')
        return { item: step.item, produced: output }
      })
    }
    if (step.tool === 'build') {
      const plot = this.manager.taskRegions.find(r => r.slotName === this.slot.name), origin = step.position || plot.origin
      this.point(origin); this.point([origin[0] + step.width, origin[1] + step.height, origin[2] + step.depth])
      const region = { ...plot, origin, min: { x: Math.min(plot.min.x,origin[0]-3), y: Math.min(plot.min.y,origin[1]), z: Math.min(plot.min.z,origin[2]-3) }, max: { x: Math.max(plot.max.x,origin[0]+step.width+3), y: Math.max(plot.max.y,origin[1]+step.height+2), z: Math.max(plot.max.z,origin[2]+step.depth+3) } }
      const plan = compileTaskPlan({ action: 'build_structure', structure: step.structure, width: step.width, depth: step.depth, height: step.height, material: step.item }, region)
      const missing = plan.placements.filter(p => this.block(p.position).name !== p.material)
      if (missing.some(p => !empty.has(this.block(p.position).name))) throw Error('BUILD_AREA_OCCUPIED')
      if (count() < missing.length) throw Error('BUILD_NEEDS_' + missing.length + '_' + step.item)
      const adapter = new NativeTaskAdapter({ bot, rootDirectory: this.rootDirectory, region, check: () => { if (this.cancelled?.()) throw Error('OBJECTIVE_STOPPED') } })
      for (const placement of missing) {
        const before = count()
        await this.effect({ action: 'place', item: placement.material, position: placement.position }, () => adapter.place(placement.position, placement.material), () => {
          if (this.block(placement.position).name !== placement.material || count() !== before - 1) throw Error('BUILD_RECEIPT_UNCERTAIN')
          return { position: placement.position, block: placement.material, consumed: 1 }
        })
      }
      if (plan.placements.some(p => this.block(p.position).name !== p.material)) throw Error('BUILD_VERIFICATION_FAILED')
      return { structure: step.structure, origin, verifiedBlocks: plan.placements.length, consumed: missing.length }
    }
    if (step.tool === 'activate') {
      const block = this.block(step.position)
      if (!/lever|button|door|trapdoor|repeater|comparator|fence_gate/.test(block.name)) throw Error('ACTIVATION_TARGET_NOT_ALLOWED')
      await this.move(step.position, 2)
      return this.effect({ action: 'activate', position: step.position, blockBefore: block.getProperties() }, () => bot.activateBlock(block), () => ({ block: this.block(step.position).name, properties: this.block(step.position).getProperties() }))
    }
    if (step.tool === 'deposit' || step.tool === 'withdraw') {
      const plot = this.manager.taskRegions.find(r => r.slotName === this.slot.name)
      if (step.tool === 'withdraw' && String(step.position) !== String(plot.sourceChest)) throw Error('WITHDRAW_OWN_SOURCE_CHEST_ONLY')
      const block = this.block(step.position); if (!['chest', 'barrel', 'trapped_chest'].includes(block.name)) throw Error('CHEST_REQUIRED')
      const id = bot.registry.itemsByName[step.item]?.id; if (id === undefined) throw Error('UNKNOWN_ITEM')
      await this.move(step.position, 2); const chest = await bot.openContainer(block)
      try {
        const before = count(), available = step.tool === 'deposit' ? before : chest.containerItems().filter(x => x.name === step.item).reduce((n, x) => n + x.count, 0)
        if (available < step.count) throw Error('INSUFFICIENT_CONTAINER_ITEMS')
        return await this.effect({ action: step.tool, item: step.item, count: step.count, position: step.position }, async () => { await chest[step.tool](id, null, step.count); chest.close() }, () => {
          if (count() !== before + (step.tool === 'deposit' ? -step.count : step.count)) throw Error('TRANSFER_RECEIPT_UNCERTAIN')
          return { item: step.item, moved: step.count, destination: step.position }
        })
      } finally { chest.close() }
    }
    if (step.tool === 'smelt') {
      const block = this.block(step.position); if (!['furnace', 'smoker', 'blast_furnace'].includes(block.name)) throw Error('FURNACE_REQUIRED')
      const input = bot.inventory.items().find(x => x.name === step.item && x.count >= step.count), fuel = bot.inventory.items().find(x => x.name === (step.fuel || 'coal'))
      if (!input || !fuel) throw Error('SMELTING_INPUT_AND_FUEL_REQUIRED')
      await this.move(step.position, 2); const furnace = await bot.openFurnace(block)
      try {
        if (furnace.inputItem() || furnace.outputItem() || furnace.fuelItem()) throw Error('USE_AN_EMPTY_FURNACE')
        return await this.effect({ action: 'smelt', item: step.item, count: step.count, position: step.position }, async () => {
          await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(step.count / 8)))
          await furnace.putInput(input.type, null, step.count)
          const deadline = Date.now() + step.count * 11000 + 10000
          while ((furnace.outputItem()?.count || 0) < step.count) { await this.guard(); if (Date.now() > deadline) throw Error('SMELT_PENDING_IN_FURNACE'); await pause(500) }
          const output = furnace.outputItem(), before = inventory(bot)[output.name] || 0
          await furnace.takeOutput(); furnace.close()
          return { name: output.name, count: output.count, before }
        }, output => { if ((inventory(bot)[output.name] || 0) - output.before !== output.count) throw Error('SMELT_RECEIPT_UNCERTAIN'); return { output: output.name, produced: output.count, inventory: inventory(bot) } })
      } finally { furnace.close() }
    }
    if (step.tool === 'hunt') {
      const dropsBefore = inventory(bot); let killed = 0
      for (; killed < step.count; killed++) {
        const target = Object.values(bot.entities).filter(e => e.name === step.animal && !e.username && e.position.distanceTo(bot.entity.position) <= 24).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        if (!target) { if (killed) break; throw Error('ANIMAL_NOT_OBSERVED') }
        await this.move(xyz(target.position), 1)
        await this.effect({ action: 'hunt', animal: step.animal, position: xyz(target.position) }, async () => {
          for (let n = 0; n < 16 && bot.entities[target.id]; n++) { await this.guard(); await bot.lookAt(target.position.offset(0, 0.5, 0)); bot.attack(target); await pause(650) }
          if (bot.entities[target.id]) throw Error('ANIMAL_NOT_DEFEATED')
          await this.move(xyz(target.position), 0); await pause(500)
        }, () => ({ animalGone: !bot.entities[target.id], inventory: inventory(bot) }))
      }
      return { hunted: killed, inventoryBefore: dropsBefore, inventoryAfter: inventory(bot) }
    }
    throw Error('SURVIVAL_TOOL_NOT_IMPLEMENTED')
  }
}
