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
};

// Monsters that live in or by water: Crescent Lake, Glowing Depths, Sea Cliffside, Shipwreck Isles, Drowned Abyss, and the Toxic Bog's fish.
const WATER = ['MelvorBase:Spitterfish', 'MelvorBase:Sailfish', 'MelvorBase:NightfangFish', 'MelvorBase:Culfish', 'MelvorBase:BlightedTorfish', 'MelvorBase:GlowingJellyfish', 'MelvorBase:GlowingLurker', 'MelvorBase:Glowsquid', 'MelvorBase:GlowingEel', 'MelvorBase:HypnoticGlowsquid', 'MelvorBase:SeaGriffin', 'MelvorBase:SeaPelican', 'MelvorBase:SeaGullwing', 'MelvorBase:SeaPegasus', 'MelvorBase:SeaDrake', 'MelvorBase:DrownedCrewman', 'MelvorBase:DrownedRifleman', 'MelvorBase:DrownedPossessor', 'MelvorBase:DrownedQuartermaster', 'MelvorBase:DrownedPirateCaptain', 'MelvorBase:DrownedOne', 'MelvorBase:DrownedVessel', 'MelvorBase:DrownedFlayer', 'MelvorBase:Krakeling', 'MelvorBase:DrownedOvermind', 'MelvorBase:ToxicRazorfish'];
// Animals: the Corrupted Farmlands' livestock, wolves, stags, boars, hounds and the Storm Valley's cats.
const BEASTS = ['MelvorBase:GiantChicken', 'MelvorBase:MagicCow', 'MelvorBase:EnragedBoar', 'MelvorBase:Wolf', 'MelvorBase:DireWolf', 'MelvorBase:SavageDireWolf', 'MelvorBase:SpiritStag', 'MelvorBase:BloodHound', 'MelvorBase:StormLynx', 'MelvorBase:StormFang', 'MelvorBase:StormBeast'];

const donate = (id, text, need, group) => ({ id, kind: 'donate', text, need: need * SCALE, group });
const kill = (id, text, need, enemies) => ({ id, kind: 'kill', text, need: need * SCALE, ...(enemies ? { enemies } : {}) });
const lap = (id, text, need) => ({ id, kind: 'lap', text, need: need * SCALE });
const steal = (id, text, need) => ({ id, kind: 'steal', text, need: need * SCALE });

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
];
