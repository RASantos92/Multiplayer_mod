using System.Text;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Entities.Bank;
using Godot;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Developer tool, like the other probes. When mod-probe\bank-probe.request exists it waits for a loaded
/// save, writes bank-probe.txt (gold, bank size, items and values), then does a round trip that should leave
/// the bank exactly as it was: take one of the cheapest sellable item and one gold out, check, put both back,
/// check. This confirms the calls the guild marketplace relies on.
/// </summary>
internal static class BankProbe
{
    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-probe");
    private static readonly string s_request = Path.Combine(s_dir, "bank-probe.request");
    private static readonly string s_output = Path.Combine(s_dir, "bank-probe.txt");

    private static bool s_done;
    private static int s_frames;

    public static bool Requested => !s_done && File.Exists(s_request);

    public static void Tick(SceneTree tree)
    {
        if (s_done) return;
        Game? game = GameAccess.Current(tree);
        if (game == null)
        {
            s_frames = 0;
            return;
        }
        if (++s_frames < 300) return;

        s_done = true;
        var log = new StringBuilder();
        try
        {
            Run(game, log);
        }
        catch (Exception e)
        {
            log.AppendLine("!! " + e);
        }
        Directory.CreateDirectory(s_dir);
        File.WriteAllText(s_output, log.ToString());
        File.Delete(s_request);
        ModEntry.Log("Bank probe written to " + s_output);
    }

    private static void Run(Game game, StringBuilder log)
    {
        log.AppendLine("# Melvor Idle 2 bank probe " + DateTime.Now.ToString("u"));
        BankEntity? bank = BankAccess.Find(game);
        log.AppendLine("bank found: " + (bank != null) + "  gold currency found: " + (BankAccess.Gold(game) != null));
        if (bank == null) return;

        log.AppendLine("gold: " + BankAccess.GoldBalance(game));
        log.AppendLine("stacks: " + bank.Inventory.StackCount + " / " + bank.Inventory.MaxStacks);
        log.AppendLine("currencies in wallet: " + string.Join(", ", bank.Wallet.Stacks.Keys.Select(c => c.Id)));

        List<BankItem> items = BankAccess.Items(game);
        log.AppendLine();
        log.AppendLine("## Items (" + items.Count + ")");
        foreach (BankItem entry in items.OrderBy(i => i.Item.Id))
        {
            log.AppendLine("  " + entry.Item.Id + "  x" + entry.Quantity + "  value " + entry.Value
                + "  sells for " + entry.Item.SellsFor.Quantity + " " + entry.Item.SellsFor.Currency.Id
                + (entry.Locked ? "  LOCKED" : "") + "  name=" + BankAccess.Name(entry.Item)
                + "  icon=" + entry.Item.Icon?.ResourcePath);
        }

        log.AppendLine();
        log.AppendLine("## Round trip");
        BankItem? pick = items.Where(i => i.Value > 0 && !i.Locked && i.Quantity >= 2).OrderBy(i => i.Value).FirstOrDefault();
        if (pick == null)
        {
            log.AppendLine("skipped: no unlocked item with a gold value and at least 2 in the bank");
            return;
        }
        if (BankAccess.GoldBalance(game) < 1)
        {
            log.AppendLine("skipped: no gold");
            return;
        }

        string State() => pick.Item.Id + " x" + bank.Inventory.GetQuantity(pick.Item) + "  gold " + BankAccess.GoldBalance(game)
            + "  stacks " + bank.Inventory.StackCount;

        log.AppendLine("before:      " + State());
        string? outError = BankAccess.Exchange(game, null, 0, pick.Item, 1, 0, 1);
        log.AppendLine("take 1 + 1g: " + (outError ?? "ok") + "   " + State());
        if (outError != null) return;

        string? backError = BankAccess.Exchange(game, pick.Item, 1, null, 0, 1, 0);
        log.AppendLine("give back:   " + (backError ?? "ok") + "   " + State());

        // The two refusals the market depends on: both must change nothing.
        string? tooMuchGold = BankAccess.Exchange(game, null, 0, null, 0, 0, BankAccess.GoldBalance(game) + 1);
        log.AppendLine("overspend:   " + (tooMuchGold ?? "ALLOWED (wrong)") + "   " + State());
        string? tooManyItems = BankAccess.Exchange(game, null, 0, pick.Item, bank.Inventory.GetQuantity(pick.Item) + 1, 0, 0);
        log.AppendLine("oversell:    " + (tooManyItems ?? "ALLOWED (wrong)") + "   " + State());

        BankAccess.SaveNow(game);
        log.AppendLine("saved");
    }
}
