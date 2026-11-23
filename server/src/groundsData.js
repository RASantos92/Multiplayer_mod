// Guild Grounds content: tiers, locations, their tasks and the bonus each location gives.
// It lives on the server so numbers and item lists can be retuned without a new mod release.
//
// Task kinds:
//   donate  members give items from their bank. `group` names an ordered list of items in GROUPS;
//           the group's `base` item is worth 1, each step up 25% more, each step down 25% less to give
//           (so a step down needs 25% more items).
//   count   something done by playing. `stat` is one of the game's own lifetime counters, which keep a
//           total per game object, and `ids` says which objects count (without it, all of them):
//             MelvorBase:CombatEnemyKilled         monsters killed, per monster
//             MelvorBase:AgilityCourseCompleted    Agility courses completed, per course
//             MelvorBase:ThievingSuccessfulAction  successful Thieving actions, per target
//             MelvorBase:<Skill>ItemGained         items a skill produced, per item
//           The mod reports how much those totals grew; `kind` only tells players what sort of task it is.
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
  logs5: { base: 'MelvorBase:MahoganyLog', items: ['MelvorBase:NormalLog', 'MelvorBase:OakLog', 'MelvorBase:WillowLog', 'MelvorBase:TeakLog', 'MelvorBase:MapleLog', 'MelvorBase:MahoganyLog', 'MelvorBase:YewLog', 'MelvorBase:MagicLog', 'MelvorBase:AshenLog', 'MelvorBase:HardOakLog', 'MelvorBase:RedwoodLog'] },
  crops5: { base: 'MelvorBase:Corn', items: ['MelvorBase:Potato', 'MelvorBase:Onion', 'MelvorBase:Lettuce', 'MelvorBase:Strawberry', 'MelvorBase:Garlic', 'MelvorBase:Corn', 'MelvorBase:Nightreed', 'MelvorBase:Watermelon', 'MelvorBase:SnapeGrass', 'MelvorBase:Tomato', 'MelvorBase:Carrot', 'MelvorBase:Pumpkin', 'MelvorBase:Cabbage', 'MelvorBase:Cauliflower'] },
  bars5: { base: 'MelvorBase:SteelBar', items: ['MelvorBase:CopperBar', 'MelvorBase:IronBar', 'MelvorBase:SteelBar', 'MelvorBase:SilverBar', 'MelvorBase:GoldBar', 'MelvorBase:MithrilBar', 'MelvorBase:IronsteelBar', 'MelvorBase:AdamantiteBar', 'MelvorBase:RuniteBar', 'MelvorBase:DawnsteelBar', 'MelvorBase:DragoniteBar'] },
  precious: { base: 'MelvorBase:SilverBar', items: ['MelvorBase:SilverBar', 'MelvorBase:GoldBar'] },
  cloth: { base: 'MelvorBase:Wool', items: ['MelvorBase:Wool', 'MelvorBase:Silk'] },
  bones4: { base: 'MelvorBase:BigBone', items: ['MelvorBase:Bone', 'MelvorBase:BigBone', 'MelvorBase:LargeBone', 'MelvorBase:SmallDragonBone', 'MelvorBase:DragonBone', 'MelvorBase:LargeDragonBone'] },
};



// Combat areas kill tasks can name: the area's name in the game and the monsters that live there.
export const AREAS = {
  GolbinForest: { name: 'Golbin Forest', difficulty: 'Easy', enemies: ['MelvorBase:Golbin', 'MelvorBase:GolbinScout', 'MelvorBase:MindGolbin', 'MelvorBase:GolbinAmbusher', 'MelvorBase:Hobgolbin'] },
  CorruptedFarmlands: { name: 'Corrupted Farmlands', difficulty: 'Easy', enemies: ['MelvorBase:EvilPlant', 'MelvorBase:GiantChicken', 'MelvorBase:MagicCow', 'MelvorBase:Scarecrow', 'MelvorBase:JackOLantern'] },
  GreenMangroves: { name: 'Green Mangroves', difficulty: 'Intermediate', enemies: ['MelvorBase:MangroveStrider', 'MelvorBase:BugSwarm', 'MelvorBase:CreeperVines', 'MelvorBase:MangroveCaterpillar', 'MelvorBase:MangroveMantis'] },
  MistyThicket: { name: 'Misty Thicket', difficulty: 'Intermediate', enemies: ['MelvorBase:Treant', 'MelvorBase:WillOWisp', 'MelvorBase:OakTreant', 'MelvorBase:SpiritStag', 'MelvorBase:WillowTreant'] },
  ToweringDivide: { name: 'Towering Divide', difficulty: 'Advanced', enemies: ['MelvorBase:Wolf', 'MelvorBase:Harpy', 'MelvorBase:DireWolf', 'MelvorBase:StoneElemental', 'MelvorBase:SavageDireWolf'] },
  DrearyBarrens: { name: 'Dreary Barrens', difficulty: 'Elite', enemies: ['MelvorBase:Vampire', 'MelvorBase:Nightwing', 'MelvorBase:DarkWizard', 'MelvorBase:Dreadspine', 'MelvorBase:ElderVampire'] },
  ShipwreckIsles: { name: 'Shipwreck Isles', difficulty: 'Elite', enemies: ['MelvorBase:DrownedCrewman', 'MelvorBase:DrownedRifleman', 'MelvorBase:DrownedPossessor', 'MelvorBase:DrownedQuartermaster', 'MelvorBase:DrownedPirateCaptain'] },
  SlimeForest: { name: 'Slime Forest', difficulty: 'Easy', enemies: ['MelvorBase:GreenSlime', 'MelvorBase:RedSlime', 'MelvorBase:BlueSlime', 'MelvorBase:BlackSlime', 'MelvorBase:RainbowSlime'] },
  StingingNest: { name: 'Stinging Nest', difficulty: 'Intermediate', enemies: ['MelvorBase:Bee', 'MelvorBase:GiantBee', 'MelvorBase:GiantHornet', 'MelvorBase:AngryWasp', 'MelvorBase:RoyalBee'] },
  ToxicBog: { name: 'Toxic Bog', difficulty: 'Intermediate', enemies: ['MelvorBase:BogBloomer', 'MelvorBase:CarrionCrow', 'MelvorBase:ToxicRazorfish', 'MelvorBase:ToxicMoth', 'MelvorBase:Plaguewing'] },
  Murkwoods: { name: 'Murkwoods', difficulty: 'Intermediate', enemies: ['MelvorBase:MurkwoodSpider', 'MelvorBase:MurkwoodTrapper', 'MelvorBase:MurkwoodSpinner', 'MelvorBase:MurkwoodBroodlings', 'MelvorBase:MurkwoodWeaver'] },
  Mausoleum: { name: 'Mausoleum', difficulty: 'Advanced', enemies: ['MelvorBase:StoneGargoyle', 'MelvorBase:PhantasmOrb', 'MelvorBase:PhantasmKnight', 'MelvorBase:PhantasmWraith', 'MelvorBase:PhantasmGuardian'] },
  DragonsPass: { name: 'Dragon\'s Pass', difficulty: 'Advanced', enemies: ['MelvorBase:Drake', 'MelvorBase:Wyvern', 'MelvorBase:GreenDragon', 'MelvorBase:BlueDragon', 'MelvorBase:RedDragon'] },
  BlackstoneBasin: { name: 'Blackstone Basin', difficulty: 'Advanced', enemies: ['MelvorBase:GasBall', 'MelvorBase:BlackstoneRoller', 'MelvorBase:SpikySlug', 'MelvorBase:BlackstoneShooter', 'MelvorBase:BlackstoneGolem'] },
  DesertPlains: { name: 'Desert Plains', difficulty: 'Advanced', enemies: ['MelvorBase:SandScorpion', 'MelvorBase:SandNomad', 'MelvorBase:SandNomadTrapper', 'MelvorBase:SandNomadWarrior', 'MelvorBase:SandNomadMage'] },
  SeaOfSand: { name: 'Sea of Sand', difficulty: 'Advanced', enemies: ['MelvorBase:SandSpitter', 'MelvorBase:SandMummy', 'MelvorBase:SandDrake', 'MelvorBase:SandSentinel', 'MelvorBase:BabyWurm'] },
  GemstonePinnacles: { name: 'Gemstone Pinnacles', difficulty: 'Elite', enemies: ['MelvorBase:ElderWyvern', 'MelvorBase:BlackDragon', 'MelvorBase:SapphireDragon', 'MelvorBase:RubyDragon', 'MelvorBase:EmeraldDragon'] },
  WindyPlains: { name: 'Windy Plains', difficulty: 'Elite', enemies: ['MelvorBase:WindDrifter', 'MelvorBase:WindElemental', 'MelvorBase:Zephyr', 'MelvorBase:TornadicElemental', 'MelvorBase:WindRipperDrake'] },
  Bloodlands: { name: 'Bloodlands', difficulty: 'Elite', enemies: ['MelvorBase:BloodImp', 'MelvorBase:BloodHound', 'MelvorBase:BloodReaper', 'MelvorBase:BloodFiend', 'MelvorBase:BloodSummoner'] },
  DrownedAbyss: { name: 'Drowned Abyss', difficulty: 'AwHellNah', enemies: ['MelvorBase:DrownedOne', 'MelvorBase:DrownedVessel', 'MelvorBase:DrownedFlayer', 'MelvorBase:Krakeling', 'MelvorBase:DrownedOvermind'] },
  DracolithCaverns: { name: 'Dracolith Caverns', difficulty: 'AwHellNah', enemies: ['MelvorBase:Dracolith', 'MelvorBase:DracolithWyrm', 'MelvorBase:DracolithRavager', 'MelvorBase:DracolithSpitfire', 'MelvorBase:DracolithTyrant'] },
  StormValley: { name: 'Storm Valley', difficulty: 'Elite', enemies: ['MelvorBase:StormLynx', 'MelvorBase:StormFang', 'MelvorBase:StormElemental', 'MelvorBase:StormBeast', 'MelvorBase:StormDragon'] },
  KelsarinWastes: { name: 'Kelsarin Wastes', difficulty: 'Elite', enemies: ['MelvorBase:KelsarinWastelander', 'MelvorBase:KelsarinSkirmisher', 'MelvorBase:KelsarinMauler', 'MelvorBase:KelsarinArcher', 'MelvorBase:KelsarinWarmage'] },
  CrescentLake: { name: 'Crescent Lake', difficulty: 'Intermediate', enemies: ['MelvorBase:Spitterfish', 'MelvorBase:Sailfish', 'MelvorBase:NightfangFish', 'MelvorBase:Culfish', 'MelvorBase:BlightedTorfish'] },
  SiltedOasis: { name: 'Silted Oasis', difficulty: 'Intermediate', enemies: ['MelvorBase:SilkbackScarab', 'MelvorBase:Siltspinner', 'MelvorBase:SiltScuttler', 'MelvorBase:SiltMosquito', 'MelvorBase:SiltMass'] },
  SeaCliffside: { name: 'Sea Cliffside', difficulty: 'Intermediate', enemies: ['MelvorBase:SeaGriffin', 'MelvorBase:SeaPelican', 'MelvorBase:SeaGullwing', 'MelvorBase:SeaPegasus', 'MelvorBase:SeaDrake'] },
};

const donate = (id, text, need, group) => ({ id, kind: 'donate', text, need: need * SCALE, group });
const kill = (id, need, area) => ({
  id, kind: 'kill', text: `Defeat monsters in ${AREAS[area].name}`, need: need * SCALE,
  stat: 'MelvorBase:CombatEnemyKilled', ids: AREAS[area].enemies, area: AREAS[area].name,
});


/**
 * A location: two donations, one combat area, and two actions that fit the place.
 * Task ids are `<location>_<suffix>`: the donation's own suffix, `kills`, then `act1` and `act2`.
 */
function place(id, name, bonus, [d1, d2, k, a1, a2]) {
  return { id, name, bonus, tasks: [d1(id), d2(id), kill(`${id}_kills`, k[0], k[1]), a1(`${id}_act1`), a2(`${id}_act2`)] };
}
const give = (suffix, text, need, group) => (place) => donate(`${place}_${suffix}`, text, need, group);
const mb = (ids) => ids.map((id) => `MelvorBase:${id}`);
const count = (kind, stat) => (text, need, ids) => (id) => ({ id, kind, text, need: need * SCALE, stat, ...(ids?.length ? { ids: mb(ids) } : {}) });
/** Items a skill produced: smithed, cooked, chopped, harvested... The player keeps them. */
const make = (skill, text, need, ids) => count('make', `MelvorBase:${skill}ItemGained`)(text, need, ids);
const hunt = count('hunt', 'MelvorBase:HuntingAnimalTrapped');
const course = count('course', 'MelvorBase:AgilityCourseCompleted');
const pick = count('thieve', 'MelvorBase:ThievingSuccessfulAction');
const burn = count('burn', 'MelvorBase:FiremakingItemSpent');
const bury = count('bury', 'MelvorBase:BankItemBuried');
/** Anything a counter counts, whatever the object. */
const any = (stat, text, need) => count('do', stat)(text, need);
const xp = (skill, value) => ({ id: `xp:${skill}`, value, text: `+${value}% ${skill} XP` });
const twice = (skill, value) => ({ id: `double:${skill}`, value, text: `${value}% chance of double ${skill} output` });
const faster = (skill, value) => ({ id: `speed:${skill}`, value, text: `${skill} ${value}% faster` });

export const TIERS = [
  {
    id: 't1',
    name: 'Perimeter',
    locations: [
      place('gatehouse', 'Gatehouse', { id: 'protection', value: 2, text: '+2% protection rating' }, [
        give('logs', 'Donate logs for the gate', 500, 'logs'),
        give('stone', 'Donate stone or ore for repairs', 300, 'stone'),
        [100, 'GolbinForest'],
        course('Complete the Climb 1 Agility course', 25, ['Climb1']),
        pick('Pickpocket Citizens', 40, ['Citizen']),
      ]),
      place('watchtower', 'Watchtower', { id: 'rangedAccuracy', value: 2, text: '+2% ranged accuracy rating' }, [
        give('logs', 'Donate logs for scaffolding', 400, 'logs'),
        give('feathers', 'Donate feathers from the roost', 200, 'feathers'),
        [50, 'GolbinForest'],
        make('Fletching', 'Fletch Arrow Shafts, Headless Arrows or Stone Arrows', 300, ['ArrowShaft', 'HeadlessArrows', 'StoneArrows']),
        hunt('Trap Wild Chickens or Greentail Birds', 30, ['WildChicken', 'GreentailBird']),
      ]),
      place('ramparts', 'Ramparts', { id: 'damageTaken', value: 3, text: '3% less damage taken' }, [
        give('stone', 'Donate stone or ore for the wall face', 400, 'stone'),
        give('clay', 'Donate clay for mortar', 150, 'clay'),
        [75, 'SlimeForest'],
        make('Smithing', 'Smelt Copper Bars', 100, ['CopperBar']),
        course('Complete the Climb 2 Agility course', 30, ['Climb2']),
      ]),
      place('moat', 'Moat & Drawbridge', { id: 'fishingSpeed', value: 2, text: 'Fishing 2% faster' }, [
        give('fish', 'Donate raw fish to stock the moat', 300, 'fish'),
        give('crops', 'Donate crops and reeds from the bank', 250, 'crops'),
        [60, 'SlimeForest'],
        make('Cooking', 'Cook Shrimp or Sardines', 150, ['Shrimp', 'Sardine']),
        pick('Pickpocket Thugs', 30, ['Thug']),
      ]),
      place('kennels', 'Kennels', { id: 'ranchingSpeed', value: 3, text: 'Ranching 3% faster' }, [
        give('bones', 'Donate bones for the yard', 200, 'bones'),
        give('straw', 'Donate wheat or sugarcane for bedding', 150, 'straw'),
        [60, 'CorruptedFarmlands'],
        hunt('Trap Wild Cows or Bushland Rabbits', 40, ['WildCow', 'BushlandRabbit']),
        make('Crafting', 'Tan Leather', 80, ['Leather']),
      ]),
    ],
  },
  {
    id: 't2',
    name: 'Yard & Craft',
    locations: [
      place('trainingyard', 'Training Yard', { id: 'meleeAccuracy', value: 3, text: '+3% melee accuracy rating' }, [
        give('stone', 'Donate stone or ore for weights', 300, 'stone'),
        give('logs', 'Donate logs for training dummies', 400, 'logs2'),
        [200, 'GreenMangroves'],
        course('Complete the Jump 1 or Climb 3 Agility course', 40, ['Jump1', 'Climb3']),
        make('Smithing', 'Smelt Iron or Steel Bars', 150, ['IronBar', 'SteelBar']),
      ]),
      place('archeryrange', 'Archery Range', { id: 'rangedDamage', value: 3, text: '+3% ranged max hit' }, [
        give('logs', 'Donate logs for arrow shafts', 500, 'logs2'),
        give('feathers', 'Donate feathers for fletching', 300, 'feathers'),
        [150, 'MistyThicket'],
        make('Fletching', 'Fletch Iron or Steel Arrows', 500, ['IronArrows', 'SteelArrows']),
        make('Fletching', 'Fletch Oak or Willow Bows', 40, ['OakBow', 'WillowBow']),
      ]),
      place('joustinglists', 'Jousting Lists', { id: 'meleeDamage', value: 3, text: '+3% melee max hit' }, [
        give('crops', 'Donate feed crops', 250, 'crops'),
        give('straw', 'Donate wheat or sugarcane for bedding', 200, 'straw'),
        [100, 'SiltedOasis'],
        hunt('Trap Thornback Lizards or Wild Boars', 30, ['ThornbackLizard', 'WildBoar']),
        course('Complete the Evade 1 or Jump 2 Agility course', 30, ['Evade1', 'Jump2']),
      ]),
      place('forgeyard', 'Forge Yard', xp('Smithing', 4), [
        give('ore', 'Donate ore from the yard seam', 600, 'ore'),
        give('coal', 'Donate coal or charcoal', 300, 'coal'),
        [100, 'Murkwoods'],
        burn('Burn Oak or Willow Logs for charcoal', 200, ['OakLog', 'WillowLog']),
        pick('Pickpocket Craftsmen', 30, ['Craftsman']),
      ]),
      place('smithy', 'Smithy', twice('Smithing', 4), [
        give('ore', 'Donate ore for the furnace', 500, 'ore'),
        give('coal', 'Donate coal or charcoal', 250, 'coal'),
        [80, 'ToxicBog'],
        make('Smithing', 'Smelt Iron, Silver or Steel Bars', 200, ['IronBar', 'SilverBar', 'SteelBar']),
        pick('Crack Locked Thug Chests', 35, ['LockedThugChest']),
      ]),
      place('masonryyard', 'Masonry Yard', xp('Mining', 4), [
        give('stone', 'Donate stone or ore for blocks', 500, 'stone'),
        give('bars', 'Donate metal bars for chisels', 250, 'bars'),
        [70, 'SeaCliffside'],
        make('Mining', 'Mine Coal', 250, ['Coal']),
        course('Complete the Climb 4 Agility course', 30, ['Climb4']),
      ]),
      place('sawmill', 'Sawmill', xp('Woodcutting', 4), [
        give('logs', 'Donate logs for the saws', 700, 'logs2'),
        give('bars', 'Donate metal bars for saw teeth', 200, 'bars'),
        [80, 'MistyThicket'],
        make('Woodcutting', 'Chop Willow or Teak Logs', 300, ['WillowLog', 'TeakLog']),
        pick('Pickpocket Farmers', 35, ['Farmer']),
      ]),
      place('carpenter', 'Carpenter\'s Workshop', faster('Crafting', 3), [
        give('logs', 'Donate logs for the benches', 600, 'logs2'),
        give('bars', 'Donate metal bars for nails and fittings', 250, 'bars'),
        [70, 'GreenMangroves'],
        make('Fletching', 'Fletch Normal, Oak or Willow Bows', 60, ['NormalBow', 'OakBow', 'WillowBow']),
        make('Crafting', 'Craft Leather or Hard Leather armour', 40, ['LeatherVambraces', 'LeatherBoots', 'LeatherCowl', 'LeatherShield', 'LeatherChaps', 'LeatherBody', 'HardLeatherVambraces', 'HardLeatherBoots', 'HardLeatherCowl', 'HardLeatherShield', 'HardLeatherChaps', 'HardLeatherBody']),
      ]),
      place('tannery', 'Tannery', twice('Crafting', 4), [
        give('hides', 'Donate hides from the pens', 250, 'hides'),
        give('leaves', 'Donate flax or leaves for tanning', 200, 'leaves'),
        [90, 'CrescentLake'],
        hunt('Trap Wild Cows or Bushland Rabbits', 40, ['WildCow', 'BushlandRabbit']),
        make('Crafting', 'Tan Leather', 150, ['Leather']),
      ]),
      place('armory', 'Armory', { id: 'protection', value: 3, text: '+3% protection rating' }, [
        give('ore', 'Donate ore for fittings', 500, 'ore'),
        give('leather', 'Donate leather for straps', 200, 'leather'),
        [120, 'StingingNest'],
        make('Crafting', 'Craft Studded Leather armour', 25, ['StuddedLeatherVambraces', 'StuddedLeatherBoots', 'StuddedLeatherCowl', 'StuddedLeatherShield', 'StuddedLeatherChaps', 'StuddedLeatherBody']),
        pick('Pickpocket Capital Guards', 40, ['CapitalGuard']),
      ]),
    ],
  },
  {
    id: 't3',
    name: 'Sustenance',
    locations: [
      place('kitchen', 'Kitchen', xp('Cooking', 4), [
        give('fish', 'Donate raw fish', 400, 'fish3'),
        give('crops', 'Donate crops', 300, 'crops3'),
        [80, 'DesertPlains'],
        make('Cooking', 'Cook Trout, Pike or Salmon', 300, ['Trout', 'Pike', 'Salmon']),
        pick('Rob the Cooking Stall or pickpocket Chefs', 40, ['CookingStall', 'Chef']),
      ]),
      place('larder', 'Larder', faster('Cooking', 4), [
        give('fish', 'Donate raw fish', 400, 'fish3'),
        give('herbs', 'Donate herbs for salting', 250, 'herbs'),
        [70, 'Mausoleum'],
        make('Fishing', 'Catch Pike, Salmon or Lobster', 250, ['RawPike', 'RawSalmon', 'RawLobster']),
        hunt('Trap Wild Boars or Steppes Rabbits', 35, ['WildBoar', 'SteppesRabbit']),
      ]),
      place('butchery', 'Butchery', twice('Ranching', 4), [
        give('straw', 'Donate wheat or sugarcane as livestock feed', 300, 'straw'),
        give('bars', 'Donate metal bars for carcass hooks', 250, 'bars'),
        [120, 'ToweringDivide'],
        hunt('Trap Wild Elk or Wild Wolves', 30, ['WildElk', 'WildWolf']),
        make('Cooking', 'Cook Beef or Chicken', 200, ['Beef', 'Chicken']),
      ]),
      place('brewery', 'Brewery', xp('Herblore', 3), [
        give('straw', 'Donate wheat or sugarcane for the mash', 300, 'straw'),
        give('leaves', 'Donate flax or leaves for the brew', 250, 'leaves'),
        [70, 'BlackstoneBasin'],
        make('Farming', 'Harvest Wheat or Sugarcane', 200, ['Wheat', 'Sugarcane']),
        any('MelvorBase:HerbloreItemGained', 'Brew potions with Herblore', 100),
      ]),
      place('granary', 'Granary', twice('Farming', 4), [
        give('crops', 'Donate crops', 600, 'crops3'),
        give('straw', 'Donate wheat or sugarcane', 300, 'straw'),
        [80, 'SeaOfSand'],
        make('Farming', 'Harvest Lettuce, Strawberries, Garlic or Corn', 300, ['Lettuce', 'Strawberry', 'Garlic', 'Corn']),
        pick('Rob the Market Seed Stall', 40, ['MarketSeedStall']),
      ]),
      place('apiary', 'Apiary', xp('Ranching', 3), [
        give('flowers', 'Donate flowers', 250, 'flowers'),
        give('hive', 'Donate honey or beeswax', 200, 'hive'),
        [60, 'DragonsPass'],
        make('Ranching', 'Collect Honey or Beeswax from your bees', 200, ['Honey', 'Beeswax']),
        hunt('Catch Green Butterflies', 25, ['GreenButterfly']),
      ]),
    ],
  },
  {
    id: 't4',
    name: 'Knowledge, Faith & Arcane',
    locations: [
      place('library', 'Library', { id: 'xp:NonCombat', value: 4, text: '+4% XP in all non-combat skills' }, [
        give('logs', 'Donate logs for shelving', 500, 'logs4'),
        give('leaves', 'Donate flax or leaves for paper', 300, 'leaves'),
        [60, 'KelsarinWastes'],
        pick('Pickpocket Archivists', 40, ['Archivist']),
        course('Complete the Balance 1 Agility course', 30, ['Balance1']),
      ]),
      place('scriptorium', 'Scriptorium', xp('Runecrafting', 4), [
        give('hides', 'Donate hides for parchment', 300, 'hides'),
        give('ash', 'Donate ash or charcoal for ink', 250, 'ash'),
        [60, 'WindyPlains'],
        make('Runecrafting', 'Craft Chaos, Body or Death Runes', 500, ['ChaosRune', 'BodyRune', 'DeathRune']),
        pick('Pickpocket Wizard Scholars or Wizards', 35, ['WizardScholar', 'Wizard']),
      ]),
      place('maproom', 'Map Room', xp('Astrology', 3), [
        give('logs', 'Donate logs for survey stakes', 400, 'logs4'),
        give('gems', 'Donate uncut gems as survey markers', 250, 'gems'),
        [80, 'StormValley'],
        any('MelvorBase:AstrologyTimesConstellationStudied', 'Study constellations with Astrology', 300),
        course('Complete the Night Climb or Jump 4 Agility course', 30, ['NightClimb', 'Jump4']),
      ]),
      place('chapel', 'Chapel', xp('Prayer', 4), [
        give('bones', 'Donate bones', 300, 'bones4'),
        give('hive', 'Donate honey or beeswax for candles', 250, 'hive'),
        [100, 'DrearyBarrens'],
        bury('Bury Bones, Big Bones or Large Bones', 300, ['Bone', 'BigBone', 'LargeBone']),
        burn('Burn Blessed Logs or Blessed Oak Logs', 50, ['BlessedLog', 'BlessedOakLog']),
      ]),
      place('apothecary', 'Apothecary', twice('Herblore', 4), [
        give('herbs', 'Donate herbs', 400, 'herbs'),
        give('leaves', 'Donate flax or leaves as reagents', 250, 'leaves'),
        [70, 'Bloodlands'],
        make('Farming', 'Harvest Nomel, Oxilyme or Sporlyle Herbs', 150, ['NomelHerb', 'OxilymeHerb', 'SporlyleHerb']),
        any('MelvorBase:HerbloreItemGained', 'Brew potions with Herblore', 150),
      ]),
      place('ritualcircle', 'Ritual Circle', twice('Runecrafting', 4), [
        give('essence', 'Donate essence', 400, 'essence'),
        give('clay', 'Donate clay for glyph chalk', 250, 'clay'),
        [90, 'GemstonePinnacles'],
        make('Runecrafting', 'Craft Death, Decay or Astral Runes', 400, ['DeathRune', 'DecayRune', 'AstralRune']),
        make('Mining', 'Mine Rune, Attuned or Pure Essence', 400, ['RuneEssence', 'AttunedEssence', 'PureEssence']),
      ]),
      place('crypt', 'Crypt', { id: 'damageDealt', value: 2, text: '+2% damage dealt' }, [
        give('ore', 'Donate ore for grave markers', 400, 'ore4'),
        give('bones', 'Donate bones for burial', 300, 'bones4'),
        [200, 'ShipwreckIsles'],
        hunt('Catch Ghostly Butterflies or trap Phantoms', 40, ['GhostlyButterfly', 'Phantom']),
        course('Complete the Fleshbound Passage or Sinew Chasm Agility course', 30, ['FleshboundPassage', 'SinewChasm']),
      ]),
    ],
  },
  {
    id: 't5',
    name: 'Commerce, Prestige & Deep Grounds',
    locations: [
      place('treasury', 'Treasury', { id: 'sellPrice', value: 5, text: 'Items sell for 5% more gold' }, [
        give('ore', 'Donate ore for strongboxes', 500, 'ore4'),
        give('bars', 'Donate silver or gold bars for the coffers', 300, 'precious'),
        [100, 'GemstonePinnacles'],
        make('Smithing', 'Smelt Gold Bars', 150, ['GoldBar']),
        pick('Crack Locked Bank Chests or pickpocket Capital Citizens', 50, ['LockedBankChest', 'CapitalCitizen']),
      ]),
      place('vault', 'Vault', { id: 'bankSlots', value: 5, text: '+5 bank slots' }, [
        give('ore', 'Donate ore for fittings', 500, 'ore4'),
        give('bars', 'Donate metal bars for locks', 300, 'bars5'),
        [120, 'DrownedAbyss'],
        make('Smithing', 'Smelt Runite or Dawnsteel Bars', 100, ['RuniteBar', 'DawnsteelBar']),
        pick('Rob the Ore Stall or Gem Stall', 40, ['OreStall', 'GemStall']),
      ]),
      place('greathall', 'Great Hall', { id: 'xp:All', value: 2, text: '+2% XP in all skills' }, [
        give('logs', 'Donate logs for seating', 600, 'logs5'),
        give('crops', 'Donate crops for the feast', 400, 'crops5'),
        [100, 'KelsarinWastes'],
        make('Cooking', 'Cook Sea Bream, Cod, Sea Bass or Lionfish', 300, ['SeaBream', 'Cod', 'SeaBass', 'Lionfish']),
        make('Farming', 'Harvest Tomatoes, Carrots, Pumpkins or Cabbages', 200, ['Tomato', 'Carrot', 'Pumpkin', 'Cabbage']),
      ]),
      place('trophyhall', 'Trophy Hall', { id: 'lootDoubling', value: 3, text: '3% chance of double combat loot' }, [
        give('logs', 'Donate logs for trophy mounts', 500, 'logs5'),
        give('gems', 'Donate uncut gems for polish', 300, 'gems'),
        [150, 'StormValley'],
        hunt('Trap Raptors, Giant Eagles or Griffins', 30, ['Raptor', 'GiantEagle', 'Griffin']),
        make('Fletching', 'Fletch Emerald, Black Opal or Diamond Bolts', 150, ['EmeraldBolts', 'BlackOpalBolts', 'DiamondBolts']),
      ]),
      place('infirmary', 'Infirmary', { id: 'foodHealing', value: 5, text: '+5% healing from food' }, [
        give('herbs', 'Donate herbs', 400, 'herbs'),
        give('cloth', 'Donate wool or silk for bandages', 300, 'cloth'),
        [90, 'Bloodlands'],
        any('MelvorBase:HerbloreItemGained', 'Brew potions with Herblore', 200),
        make('Ranching', 'Collect Wool or Silk from your animals', 200, ['Wool', 'Silk']),
      ]),
      place('dormitory', 'Dormitory', { id: 'maxHitpoints', value: 4, text: '+4% maximum hitpoints' }, [
        give('logs', 'Donate logs for bunks', 600, 'logs5'),
        give('cloth', 'Donate wool or silk for linens', 400, 'cloth'),
        [80, 'WindyPlains'],
        course('Complete the Climb 6, Rappell 1 or Moonlight Dash Agility course', 35, ['Climb6', 'Rappell1', 'MoonlightDash']),
        pick('Pickpocket Palace Citizens', 40, ['PalaceCitizen']),
      ]),
      place('dungeon', 'Dungeon', xp('Slayer', 5), [
        give('stone', 'Donate stone or ore for cells', 500, 'stone'),
        give('bars', 'Donate metal bars for shackles', 300, 'bars5'),
        [250, 'DracolithCaverns'],
        any('MelvorBase:SlayerMasterTasksCompleted', 'Complete Slayer tasks', 30),
        pick('Pickpocket Palace Guards', 40, ['PalaceGuard']),
      ]),
    ],
  },
];
