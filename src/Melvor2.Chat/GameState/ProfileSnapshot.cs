using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Equipment;
using GamesByMalcs.Melvor2.Components.Experience;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Combat;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat.GameState;

/// <summary>
/// The local player's public profile for guild mates: every skill's level and the currently equipped gear,
/// as game ids. Built from the live game and sent to the guild server as JSON (PUT /me/profile).
/// </summary>
internal static class ProfileSnapshot
{
    public static string Build(Game game)
    {
        return Json.Obj(w =>
        {
            w.WriteStartArray("skills");
            foreach (ILeveledEntity<ExperienceComponent> skill in game.LeveledEntities)
            {
                w.WriteStartObject();
                w.WriteString("id", skill.Id);
                w.WriteNumber("level", skill.Experience.Level);
                w.WriteEndObject();
            }
            w.WriteEndArray();

            w.WriteStartArray("gear");
            if (game.Entities.TryGetObjectById("MelvorBase:Combat", out GameEntity? found) && found is CombatEntity combat)
            {
                EquipmentComponent equipment = combat.Equipment;
                foreach (EquipmentSlot slot in equipment.Config.EquipmentSlots)
                {
                    // Occupied = blocked by another slot's item (a two-handed weapon), so it holds nothing itself.
                    if (!equipment.TryGetActiveSlot(slot, out IActiveEquipmentSlot? active) || active.IsEmpty || active.IsOccupied) continue;
                    w.WriteStartObject();
                    w.WriteString("slot", slot.Id);
                    w.WriteString("item", active.Equipped!.Item.Id);
                    w.WriteNumber("qty", Math.Max(0, active.Quantity));
                    w.WriteEndObject();
                }
            }
            w.WriteEndArray();
        });
    }
}
