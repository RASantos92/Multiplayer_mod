// Guild Grounds content: tiers, locations, their tasks and the bonus each location gives.
// It lives on the server so numbers and item lists can be retuned without a new mod release.
//
// Task kinds:
//   donate  members give items from their bank. `group` names an ordered list of items in GROUPS;
//           the group's `base` item is worth 1, each step up 25% more, each step down 25% less to give
//           (so a step down needs 25% more items).
//   kill    monsters defeated. `enemies` limits it to those monster ids; without it any monster counts.
//   lap     Agility courses completed. `courses` limits it; without it any course counts.
//   steal   successful Thieving actions. `targets` limits it; without it any target counts.
//
// Bonus ids are a fixed list the mod knows how to apply (see GroundsBonus.cs). `value` is in percent.
// Task ids are stored in the database: never reuse or rename one that has been live.

export const STEP = 1.25;

// Every quantity written in the tables below is multiplied by this.
export const SCALE = 3;

// Items are listed in the order the game unlocks them (level needed to gather them).
export const GROUPS = {
  logs: {
    base: 'MelvorBase:WillowLog',
    items: ['MelvorBase:NormalLog', 'MelvorBase:OakLog', 'MelvorBase:WillowLog', 'MelvorBase:TeakLog', 'MelvorBase:MapleLog', 'MelvorBase:MahoganyLog', 'MelvorBase:YewLog', 'MelvorBase:MagicLog', 'MelvorBase:AshenLog', 'MelvorBase:HardOakLog', 'MelvorBase:RedwoodLog'],
  },
  stone: {
    base: 'MelvorBase:IronOre',
    items: ['MelvorBase:Stone', 'MelvorBase:CopperOre', 'MelvorBase:IronOre', 'MelvorBase:SilverOre', 'MelvorBase:Coal', 'MelvorBase:MithrilOre', 'MelvorBase:GoldOre', 'MelvorBase:AdamantiteOre', 'MelvorBase:RuniteOre', 'MelvorBase:DawnsteelOre', 'MelvorBase:MeteoriteOre', 'MelvorBase:DragoniteOre'],
  },
  fish: {
    base: 'MelvorBase:RawHerring',
    items: ['MelvorBase:RawShrimp', 'MelvorBase:RawSardine', 'MelvorBase:RawHerring', 'MelvorBase:RawPerch', 'MelvorBase:RawTrout', 'MelvorBase:RawMackerel', 'MelvorBase:RawPike', 'MelvorBase:RawMoonlightMinnow', 'MelvorBase:RawSalmon', 'MelvorBase:RawLobster', 'MelvorBase:RawGlowfin', 'MelvorBase:RawSeaBream', 'MelvorBase:RawCod', 'MelvorBase:RawSeaBass', 'MelvorBase:RawLionfish', 'MelvorBase:RawStripedMullet', 'MelvorBase:RawGlowingJellyfish', 'MelvorBase:RawTuna', 'MelvorBase:RawShark', 'MelvorBase:RawGlowingSquid', 'MelvorBase:RawGiantEel', 'MelvorBase:RawMantaRay', 'MelvorBase:RawWhale'],
  },
  crops: {
    base: 'MelvorBase:Lettuce',
    items: ['MelvorBase:Potato', 'MelvorBase:Onion', 'MelvorBase:Lettuce', 'MelvorBase:Strawberry', 'MelvorBase:Garlic', 'MelvorBase:Corn', 'MelvorBase:Nightreed', 'MelvorBase:Watermelon', 'MelvorBase:SnapeGrass', 'MelvorBase:Tomato', 'MelvorBase:Carrot', 'MelvorBase:Pumpkin', 'MelvorBase:Cabbage', 'MelvorBase:Cauliflower'],
  },
  straw: { base: 'MelvorBase:Wheat', items: ['MelvorBase:Wheat', 'MelvorBase:Sugarcane'] },
  bones: { base: 'MelvorBase:Bone', items: ['MelvorBase:Bone', 'MelvorBase:BigBone'] },
  feathers: { base: 'MelvorBase:Feathers', items: ['MelvorBase:Feathers'] },
  clay: { base: 'MelvorBase:Clay', items: ['MelvorBase:Clay'] },
  // Later tiers ask for the same kinds of things with a higher item counting as 1.
  logs2: { base: 'MelvorBase:TeakLog', items: ['MelvorBase:NormalLog', 'MelvorBase:OakLog', 'MelvorBase:WillowLog', 'MelvorBase:TeakLog', 'MelvorBase:MapleLog', 'MelvorBase:MahoganyLog', 'MelvorBase:YewLog', 'MelvorBase:MagicLog', 'MelvorBase:AshenLog', 'MelvorBase:HardOakLog', 'MelvorBase:RedwoodLog'] },
  logs4: { base: 'MelvorBase:MapleLog', items: ['MelvorBase:NormalLog', 'MelvorBase:OakLog', 'MelvorBase:WillowLog', 'MelvorBase:TeakLog', 'MelvorBase:MapleLog', 'MelvorBase:MahoganyLog', 'MelvorBase:YewLog', 'MelvorBase:MagicLog', 'MelvorBase:AshenLog', 'MelvorBase:HardOakLog', 'MelvorBase:RedwoodLog'] },
  fish3: { base: 'MelvorBase:RawTrout', items: ['MelvorBase:RawShrimp', 'MelvorBase:RawSardine', 'MelvorBase:RawHerring', 'MelvorBase:RawPerch', 'MelvorBase:RawTrout', 'MelvorBase:RawMackerel', 'MelvorBase:RawPike', 'MelvorBase:RawMoonlightMinnow', 'MelvorBase:RawSalmon', 'MelvorBase:RawLobster', 'MelvorBase:RawGlowfin', 'MelvorBase:RawSeaBream', 'MelvorBase:RawCod', 'MelvorBase:RawSeaBass', 'MelvorBase:RawLionfish', 'MelvorBase:RawStripedMullet', 'MelvorBase:RawGlowingJellyfish', 'MelvorBase:RawTuna', 'MelvorBase:RawShark', 'MelvorBase:RawGlowingSquid', 'MelvorBase:RawGiantEel', 'MelvorBase:RawMantaRay', 'MelvorBase:RawWhale'] },
  crops3: { base: 'MelvorBase:Garlic', items: ['MelvorBase:Potato', 'MelvorBase:Onion', 'MelvorBase:Lettuce', 'MelvorBase:Strawberry', 'MelvorBase:Garlic', 'MelvorBase:Corn', 'MelvorBase:Nightreed', 'MelvorBase:Watermelon', 'MelvorBase:SnapeGrass', 'MelvorBase:Tomato', 'MelvorBase:Carrot', 'MelvorBase:Pumpkin', 'MelvorBase:Cabbage', 'MelvorBase:Cauliflower'] },
  ore: { base: 'MelvorBase:IronOre', items: ['MelvorBase:CopperOre', 'MelvorBase:IronOre', 'MelvorBase:SilverOre', 'MelvorBase:MithrilOre', 'MelvorBase:GoldOre', 'MelvorBase:AdamantiteOre', 'MelvorBase:RuniteOre', 'MelvorBase:DawnsteelOre', 'MelvorBase:MeteoriteOre', 'MelvorBase:DragoniteOre'] },
  ore4: { base: 'MelvorBase:MithrilOre', items: ['MelvorBase:CopperOre', 'MelvorBase:IronOre', 'MelvorBase:SilverOre', 'MelvorBase:MithrilOre', 'MelvorBase:GoldOre', 'MelvorBase:AdamantiteOre', 'MelvorBase:RuniteOre', 'MelvorBase:DawnsteelOre', 'MelvorBase:MeteoriteOre', 'MelvorBase:DragoniteOre'] },
  coal: { base: 'MelvorBase:Coal', items: ['MelvorBase:Charcoal', 'MelvorBase:Coal'] },
  bars: { base: 'MelvorBase:IronBar', items: ['MelvorBase:CopperBar', 'MelvorBase:IronBar', 'MelvorBase:SteelBar', 'MelvorBase:SilverBar', 'MelvorBase:GoldBar', 'MelvorBase:MithrilBar', 'MelvorBase:IronsteelBar', 'MelvorBase:AdamantiteBar', 'MelvorBase:RuniteBar', 'MelvorBase:DawnsteelBar', 'MelvorBase:DragoniteBar'] },
  hides: { base: 'MelvorBase:Cowhide', items: ['MelvorBase:Cowhide', 'MelvorBase:ElkHide', 'MelvorBase:GreenDragonhide', 'MelvorBase:BlueDragonhide', 'MelvorBase:RedDragonhide', 'MelvorBase:BlackDragonhide', 'MelvorBase:CaribouHide'] },
  leather: { base: 'MelvorBase:Leather', items: ['MelvorBase:Leather', 'MelvorBase:ElkLeather', 'MelvorBase:GreenDragonhideLeather', 'MelvorBase:BlueDragonhideLeather', 'MelvorBase:RedDragonhideLeather', 'MelvorBase:BlackDragonhideLeather', 'MelvorBase:CaribouLeather'] },
  herbs: { base: 'MelvorBase:SourweedHerb', items: ['MelvorBase:PenrilHerb', 'MelvorBase:SourweedHerb', 'MelvorBase:MantalymeHerb', 'MelvorBase:NomelHerb', 'MelvorBase:OxilymeHerb', 'MelvorBase:SporlyleHerb', 'MelvorBase:LarxHerb', 'MelvorBase:BarrentoeHerb'] },
  leaves: { base: 'MelvorBase:AmbervineLeaf', items: ['MelvorBase:Flax', 'MelvorBase:AmbervineLeaf', 'MelvorBase:SpikemossLeaf', 'MelvorBase:Duskleaf'] },
  flowers: { base: 'MelvorBase:Sunflower', items: ['MelvorBase:Sunflower', 'MelvorBase:MarigoldFlower', 'MelvorBase:RosemaryFlower'] },
  hive: { base: 'MelvorBase:Honey', items: ['MelvorBase:Honey', 'MelvorBase:Beeswax'] },
  ash: { base: 'MelvorBase:Ash', items: ['MelvorBase:Ash', 'MelvorBase:Charcoal'] },
  essence: { base: 'MelvorBase:RuneEssence', items: ['MelvorBase:RuneEssence', 'MelvorBase:AttunedEssence', 'MelvorBase:PureEssence'] },
  gems: { base: 'MelvorBase:UncutTopaz', items: ['MelvorBase:UncutTopaz', 'MelvorBase:UncutSapphire', 'MelvorBase:UncutRuby', 'MelvorBase:UncutEmerald', 'MelvorBase:UncutDiamond', 'MelvorBase:UncutJadestone'] },
  bones4: { base: 'MelvorBase:BigBone', items: ['MelvorBase:Bone', 'MelvorBase:BigBone', 'MelvorBase:LargeBone', 'MelvorBase:SmallDragonBone', 'MelvorBase:DragonBone', 'MelvorBase:LargeDragonBone'] },
};

// Monsters that live in or by water: Crescent Lake, Glowing Depths, Sea Cliffside, Shipwreck Isles, Drowned Abyss, and the Toxic Bog's fish.
const WATER = ['MelvorBase:Spitterfish', 'MelvorBase:Sailfish', 'MelvorBase:NightfangFish', 'MelvorBase:Culfish', 'MelvorBase:BlightedTorfish', 'MelvorBase:GlowingJellyfish', 'MelvorBase:GlowingLurker', 'MelvorBase:Glowsquid', 'MelvorBase:GlowingEel', 'MelvorBase:HypnoticGlowsquid', 'MelvorBase:SeaGriffin', 'MelvorBase:SeaPelican', 'MelvorBase:SeaGullwing', 'MelvorBase:SeaPegasus', 'MelvorBase:SeaDrake', 'MelvorBase:DrownedCrewman', 'MelvorBase:DrownedRifleman', 'MelvorBase:DrownedPossessor', 'MelvorBase:DrownedQuartermaster', 'MelvorBase:DrownedPirateCaptain', 'MelvorBase:DrownedOne', 'MelvorBase:DrownedVessel', 'MelvorBase:DrownedFlayer', 'MelvorBase:Krakeling', 'MelvorBase:DrownedOvermind', 'MelvorBase:ToxicRazorfish'];
// Animals: the Corrupted Farmlands' livestock, wolves, stags, boars, hounds and the Storm Valley's cats.
const BEASTS = ['MelvorBase:GiantChicken', 'MelvorBase:MagicCow', 'MelvorBase:EnragedBoar', 'MelvorBase:Wolf', 'MelvorBase:DireWolf', 'MelvorBase:SavageDireWolf', 'MelvorBase:SpiritStag', 'MelvorBase:BloodHound', 'MelvorBase:StormLynx', 'MelvorBase:StormFang', 'MelvorBase:StormBeast'];

// The Corrupted Farmlands: livestock gone wrong, and what grows there.
const FARM = ['MelvorBase:GiantChicken', 'MelvorBase:MagicCow', 'MelvorBase:EvilPlant', 'MelvorBase:Scarecrow', 'MelvorBase:JackOLantern'];
// The Stinging Nest.
const HIVE = ['MelvorBase:Bee', 'MelvorBase:GiantBee', 'MelvorBase:GiantHornet', 'MelvorBase:AngryWasp', 'MelvorBase:RoyalBee'];
// Plants and things that grow.
const PLANTS = ['MelvorBase:EvilPlant', 'MelvorBase:CreeperVines', 'MelvorBase:BogBloomer', 'MelvorBase:Treant', 'MelvorBase:OakTreant', 'MelvorBase:WillowTreant', 'MelvorBase:TaintedTreant', 'MelvorBase:BrambleSerpent'];
// The dead that will not stay down: vampires, phantasms, mummies, the drowned, and the Harvest Farm's dead.
const UNDEAD = ['MelvorBase:Vampire', 'MelvorBase:ElderVampire', 'MelvorBase:PhantasmOrb', 'MelvorBase:PhantasmKnight', 'MelvorBase:PhantasmWraith', 'MelvorBase:PhantasmGuardian', 'MelvorBase:SandMummy', 'MelvorBase:UndeadFarmer', 'MelvorBase:MorgistheGraveCorruptor', 'MelvorBase:DrownedCrewman', 'MelvorBase:DrownedRifleman', 'MelvorBase:DrownedPossessor', 'MelvorBase:DrownedQuartermaster', 'MelvorBase:DrownedPirateCaptain', 'MelvorBase:DrownedOne', 'MelvorBase:DrownedVessel', 'MelvorBase:DrownedFlayer', 'MelvorBase:DrownedOvermind'];

const donate = (id, text, need, group) => ({ id, kind: 'donate', text, need: need * SCALE, group });
const kill = (id, text, need, enemies) => ({ id, kind: 'kill', text, need: need * SCALE, ...(enemies ? { enemies } : {}) });
const lap = (id, text, need) => ({ id, kind: 'lap', text, need: need * SCALE });
const steal = (id, text, need) => ({ id, kind: 'steal', text, need: need * SCALE });


/** A location with the usual five tasks: two donations, then kills, Agility laps and Thieving. */
function place(id, name, bonus, [d1, d2, k, l, st]) {
  return {
    id,
    name,
    bonus,
    tasks: [
      donate(`${id}_${d1[3] ?? 'a'}`, d1[0], d1[1], d1[2]),
      donate(`${id}_${d2[3] ?? 'b'}`, d2[0], d2[1], d2[2]),
      kill(`${id}_kills`, k[0], k[1], k[2]),
      lap(`${id}_laps`, `${l[0]} (Agility laps)`, l[1]),
      steal(`${id}_steals`, `${st[0]} (successful Thieving actions)`, st[1]),
    ],
  };
}
const xp = (skill, value) => ({ id: `xp:${skill}`, value, text: `+${value}% ${skill} XP` });
const twice = (skill, value) => ({ id: `double:${skill}`, value, text: `${value}% chance of double ${skill} output` });
const faster = (skill, value) => ({ id: `speed:${skill}`, value, text: `${skill} ${value}% faster` });

export const TIERS = [
  {
    id: 't1',
    name: 'Perimeter',
    locations: [
      {
        id: 'gatehouse',
        name: 'Gatehouse',
        bonus: { id: 'protection', value: 2, text: '+2% protection rating' },
        tasks: [
          donate('gatehouse_logs', 'Donate logs for the gate', 500, 'logs'),
          donate('gatehouse_stone', 'Donate stone or ore for repairs', 300, 'stone'),
          kill('gatehouse_kills', 'Defeat monsters on the approach', 100),
          lap('gatehouse_laps', 'Complete Agility laps of the gate run', 25),
          steal('gatehouse_steals', 'Lift gate passes (successful Thieving actions)', 40),
        ],
      },
      {
        id: 'watchtower',
        name: 'Watchtower',
        bonus: { id: 'rangedAccuracy', value: 2, text: '+2% ranged accuracy rating' },
        tasks: [
          donate('watchtower_logs', 'Donate logs for scaffolding', 400, 'logs'),
          donate('watchtower_feathers', 'Donate feathers from the roost', 200, 'feathers'),
          kill('watchtower_kills', 'Defeat monsters from the parapet', 50),
          lap('watchtower_laps', 'Climb the tower (Agility laps)', 30),
          steal('watchtower_steals', 'Pickpocket couriers (successful Thieving actions)', 30),
        ],
      },
      {
        id: 'ramparts',
        name: 'Ramparts',
        bonus: { id: 'damageTaken', value: 3, text: '3% less damage taken' },
        tasks: [
          donate('ramparts_stone', 'Donate stone or ore for the wall face', 400, 'stone'),
          donate('ramparts_clay', 'Donate clay for mortar', 150, 'clay'),
          kill('ramparts_kills', 'Defeat monsters on the walls', 75),
          lap('ramparts_laps', 'Run the walls (Agility laps)', 30),
          steal('ramparts_steals', 'Steal signal flares (successful Thieving actions)', 25),
        ],
      },
      {
        id: 'moat',
        name: 'Moat & Drawbridge',
        bonus: { id: 'fishingSpeed', value: 2, text: 'Fishing 2% faster' },
        tasks: [
          donate('moat_fish', 'Donate raw fish to stock the moat', 300, 'fish'),
          donate('moat_crops', 'Donate crops and reeds from the bank', 250, 'crops'),
          kill('moat_kills', 'Defeat water monsters (Crescent Lake and other waters)', 60, WATER),
          lap('moat_laps', 'Cross the moat (Agility laps)', 20),
          steal('moat_steals', 'Steal mooring ropes (successful Thieving actions)', 30),
        ],
      },
      {
        id: 'kennels',
        name: 'Kennels',
        bonus: { id: 'ranchingSpeed', value: 3, text: 'Ranching 3% faster' },
        tasks: [
          donate('kennels_bones', 'Donate bones for the yard', 200, 'bones'),
          donate('kennels_straw', 'Donate wheat or sugarcane for bedding', 150, 'straw'),
          kill('kennels_kills', 'Defeat beasts (farm animals, wolves, stags, hounds)', 60, BEASTS),
          lap('kennels_laps', 'Hound-handling drills (Agility laps)', 25),
          steal('kennels_steals', 'Steal dog treats (successful Thieving actions)', 40),
        ],
      },
    ],
  },
  {
    id: 't2',
    name: 'Yard & Craft',
    locations: [
      place('trainingyard', 'Training Yard', { id: 'meleeAccuracy', value: 3, text: '+3% melee accuracy rating' }, [
        ['Donate stone or ore for weights', 300, 'stone', 'stone'], ['Donate logs for training dummies', 400, 'logs2', 'logs'],
        ['Defeat monsters in sparring', 200], ['Run drills', 40], ['Steal sparring schedules', 30]]),
      place('archeryrange', 'Archery Range', { id: 'rangedDamage', value: 3, text: '+3% ranged max hit' }, [
        ['Donate logs for arrow shafts', 500, 'logs2', 'logs'], ['Donate feathers for fletching', 300, 'feathers', 'feathers'],
        ['Defeat monsters on the range course', 150], ['Sprint the target run', 35], ['Steal spent arrow bundles', 40]]),
      place('joustinglists', 'Jousting Lists', { id: 'meleeDamage', value: 3, text: '+3% melee max hit' }, [
        ['Donate feed crops', 250, 'crops', 'crops'], ['Donate wheat or sugarcane for bedding', 200, 'straw', 'straw'],
        ['Defeat monsters in the lists', 100], ['Ride tilt runs', 30], ['Steal lance pennants', 25]]),
      place('forgeyard', 'Forge Yard', xp('Smithing', 4), [
        ['Donate ore from the yard seam', 600, 'ore', 'ore'], ['Donate coal or charcoal', 300, 'coal', 'coal'],
        ['Defeat monsters at the bellows', 100], ['Haul slag', 30], ['Steal tool blanks', 30]]),
      place('smithy', 'Smithy', twice('Smithing', 4), [
        ['Donate ore for the furnace', 500, 'ore', 'ore'], ['Donate coal or charcoal', 250, 'coal', 'coal'],
        ['Defeat monsters in the shop', 80], ['Make quenching runs', 25], ['Steal guild tools', 35]]),
      place('masonryyard', 'Masonry Yard', xp('Mining', 4), [
        ['Donate stone or ore for blocks', 500, 'stone', 'stone'], ['Donate metal bars for chisels', 250, 'bars', 'bars'],
        ['Defeat monsters among the blocks', 70], ['Haul stone', 30], ["Steal mason's measures", 30]]),
      place('sawmill', 'Sawmill', xp('Woodcutting', 4), [
        ['Donate logs for the saws', 700, 'logs2', 'logs'], ['Donate metal bars for saw teeth', 200, 'bars', 'bars'],
        ['Defeat monsters in the yard', 80], ['Roll logs', 30], ['Steal marked timber', 35]]),
      place('carpenter', "Carpenter's Workshop", faster('Crafting', 3), [
        ['Donate logs for the benches', 600, 'logs2', 'logs'], ['Donate metal bars for nails and fittings', 250, 'bars', 'bars'],
        ['Defeat monsters in the shop', 70], ['Climb ladders', 25], ['Steal guild blueprints', 30]]),
      place('tannery', 'Tannery', twice('Crafting', 4), [
        ['Donate hides from the pens', 250, 'hides', 'hides'], ['Donate flax or leaves for tanning', 200, 'leaves', 'leaves'],
        ['Defeat monsters by the vats', 90], ['Haul hides', 30], ['Steal cured pelts', 30]]),
      place('armory', 'Armory', { id: 'protection', value: 3, text: '+3% protection rating' }, [
        ['Donate ore for fittings', 500, 'ore', 'ore'], ['Donate leather for straps', 200, 'leather', 'leather'],
        ['Defeat monsters in the drill hall', 120], ['Make gear-issue runs', 25], ['Steal issued loadouts', 40]]),
    ],
  },
  {
    id: 't3',
    name: 'Sustenance',
    locations: [
      place('kitchen', 'Kitchen', xp('Cooking', 4), [
        ['Donate raw fish', 400, 'fish3', 'fish'], ['Donate crops', 300, 'crops3', 'crops'],
        ['Defeat the Corrupted Farmlands raiding the pantry', 80, FARM], ['Carry trays', 30], ['Steal spice jars', 40]]),
      place('larder', 'Larder', faster('Cooking', 4), [
        ['Donate raw fish', 400, 'fish3', 'fish'], ['Donate herbs for salting', 250, 'herbs', 'herbs'],
        ['Defeat monsters in the cold store', 70], ['Stack crates', 25], ['Steal sealed preserves', 35]]),
      place('butchery', 'Butchery', twice('Ranching', 4), [
        ['Donate wheat or sugarcane as livestock feed', 300, 'straw', 'straw'], ['Donate metal bars for carcass hooks', 250, 'bars', 'bars'],
        ['Defeat the livestock of the Corrupted Farmlands', 120, FARM], ['Haul carcasses', 30], ['Steal prime cuts', 30]]),
      place('brewery', 'Brewery', xp('Herblore', 3), [
        ['Donate wheat or sugarcane for the mash', 300, 'straw', 'straw'], ['Donate flax or leaves for the brew', 250, 'leaves', 'leaves'],
        ['Defeat monsters in the cellars', 70], ['Roll barrels', 25], ['Steal cask taps', 35]]),
      place('granary', 'Granary', twice('Farming', 4), [
        ['Donate crops', 600, 'crops3', 'crops'], ['Donate wheat or sugarcane', 300, 'straw', 'straw'],
        ['Defeat the Corrupted Farmlands at the silo', 80, FARM], ['Haul sacks', 30], ['Steal grain rations', 40]]),
      place('apiary', 'Apiary', xp('Ranching', 3), [
        ['Donate flowers', 250, 'flowers', 'flowers'], ['Donate honey or beeswax', 200, 'hive', 'hive'],
        ['Defeat the bees and wasps of the Stinging Nest', 60, HIVE], ['Make netting runs', 25], ['Steal wax blocks', 30]]),
    ],
  },
  {
    id: 't4',
    name: 'Knowledge, Faith & Arcane',
    locations: [
      place('library', 'Library', { id: 'xp:NonCombat', value: 4, text: '+4% XP in all non-combat skills' }, [
        ['Donate logs for shelving', 500, 'logs4', 'logs'], ['Donate flax or leaves for paper', 300, 'leaves', 'leaves'],
        ['Defeat monsters in the stacks', 60], ['Climb ladders', 30], ['Steal overdue tomes', 40]]),
      place('scriptorium', 'Scriptorium', xp('Runecrafting', 4), [
        ['Donate hides for parchment', 300, 'hides', 'hides'], ['Donate ash or charcoal for ink', 250, 'ash', 'ash'],
        ['Defeat monsters in the annex', 60], ['Run from desk to vault', 25], ['Steal sealed scrolls', 35]]),
      place('maproom', 'Map Room', xp('Astrology', 3), [
        ['Donate logs for survey stakes', 400, 'logs4', 'logs'], ['Donate uncut gems as survey markers', 250, 'gems', 'gems'],
        ['Defeat monsters on survey routes', 80], ['Run survey laps', 30], ['Steal field reports', 30]]),
      place('chapel', 'Chapel', xp('Prayer', 4), [
        ['Donate bones', 300, 'bones4', 'bones'], ['Donate honey or beeswax for candles', 250, 'hive', 'hive'],
        ['Defeat the undead in the nave', 100, UNDEAD], ['Climb the bell tower', 25], ['Steal votive offerings', 30]]),
      place('apothecary', 'Apothecary', twice('Herblore', 4), [
        ['Donate herbs', 400, 'herbs', 'herbs'], ['Donate flax or leaves as reagents', 250, 'leaves', 'leaves'],
        ['Defeat plant monsters in the garden', 70, PLANTS], ['Climb shelf ladders', 25], ['Steal remedy kits', 35]]),
      place('ritualcircle', 'Ritual Circle', twice('Runecrafting', 4), [
        ['Donate essence', 400, 'essence', 'essence'], ['Donate clay for glyph chalk', 250, 'clay', 'clay'],
        ['Defeat monsters in the ring', 90], ['Run the circle', 30], ['Steal ritual components', 30]]),
      place('crypt', 'Crypt', { id: 'damageDealt', value: 2, text: '+2% damage dealt' }, [
        ['Donate ore for grave markers', 400, 'ore4', 'ore'], ['Donate bones for burial', 300, 'bones4', 'bones'],
        ['Defeat the undead', 200, UNDEAD], ['Descend the stairs', 30], ['Steal burial goods', 40]]),
    ],
  },
];
