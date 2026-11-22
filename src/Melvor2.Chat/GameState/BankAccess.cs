using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Inventories;
using GamesByMalcs.Melvor2.Core.InventoryWalletTransactions;
using GamesByMalcs.Melvor2.Data.Currencies;
using GamesByMalcs.Melvor2.Data.Items;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Bank;

namespace Melvor2.Chat.GameState;

/// <summary>One kind of item in the player's bank that could be listed on the guild market.</summary>
internal sealed record BankItem(Item Item, int Quantity, long Value, bool Locked);

/// <summary>
/// The player's bank and gold, for the guild marketplace. Only call from the main thread with a game from
/// <see cref="GameAccess.Current"/>, which excludes offline and catch-up progress: the bank has no locks and
/// the game ticks on another thread then.
///
/// Items moved by the market are added without the game's "found" flag, the same way the game returns
/// unequipped gear and shop refunds, so a purchase does not count as finding the item.
/// </summary>
internal static class BankAccess
{
    public const string GoldId = "MelvorBase:GoldPieces";

    public static BankEntity? Find(Game game) =>
        game.Entities.TryGetObjectById("MelvorBase:Bank", out GameEntity? found) ? found as BankEntity : null;

    public static Currency? Gold(Game game) =>
        game.Data.TryGetObject<Currency>(GoldId, out Currency? gold) ? gold : null;

    public static Item? FindItem(Game game, string id) =>
        game.Data.TryGetObject<Item>(id, out Item? item) ? item : null;

    public static string Name(Item item, int count = 1) => item.DisplayName.GetPluralText(count);

    /// <summary>
    /// What the game says one of this item is worth in gold, or 0 if it is worth nothing or is priced in
    /// another currency. This is the base value, before the player's own sale bonuses, so it is the same number
    /// on every player's machine.
    /// </summary>
    public static long ValueOf(Item item) =>
        item.SellsFor.Currency.Id == GoldId ? Math.Max(0, item.SellsFor.Quantity) : 0;

    public static long GoldBalance(Game game)
    {
        BankEntity? bank = Find(game);
        Currency? gold = Gold(game);
        return bank == null || gold == null ? 0 : bank.Wallet.GetQuantity(gold);
    }

    /// <summary>Everything in the bank with a quantity, as a copy that is safe to keep while the bank changes.</summary>
    public static List<BankItem> Items(Game game)
    {
        var items = new List<BankItem>();
        BankEntity? bank = Find(game);
        if (bank == null) return items;
        foreach (IReadonlyItemStack stack in bank.Inventory.Stacks.ToList())
        {
            if (stack.Quantity <= 0) continue;
            items.Add(new BankItem(stack.Item, stack.Quantity, ValueOf(stack.Item), stack.IsLocked));
        }
        return items;
    }

    /// <summary>
    /// One all-or-nothing change to the bank: items and gold in, items and gold out. Uses the game's own
    /// combined transaction (the shop uses it too), which checks everything first and changes nothing if the
    /// player cannot afford it or the bank has no room. Returns null on success, otherwise a reason to show.
    /// </summary>
    public static string? Exchange(Game game, Item? addItem, int addQuantity, Item? removeItem, int removeQuantity, long addGold, long removeGold)
    {
        BankEntity? bank = Find(game);
        Currency? gold = Gold(game);
        if (bank == null || gold == null) return "Your bank is not available right now.";

        var transaction = new InventoryWalletTransaction(bank.Inventory, bank.Wallet);
        transaction.Items.Options = AddItemFlags.None;
        if (addItem != null && addQuantity > 0) transaction.Items.Add(addItem, addQuantity);
        if (removeItem != null && removeQuantity > 0) transaction.Items.Remove(removeItem, removeQuantity);
        if (addGold > 0) transaction.Currencies.Add(gold, addGold);
        if (removeGold > 0) transaction.Currencies.Remove(gold, removeGold);

        return transaction.Execute() switch
        {
            InventoryWalletTransactionResult.Success => null,
            InventoryWalletTransactionResult.CantAffordItems => "You no longer have those items in your bank.",
            InventoryWalletTransactionResult.CantAffordCurrencies => "You do not have enough gold.",
            InventoryWalletTransactionResult.NotEnoughInventorySpace => "Your bank is full.",
            InventoryWalletTransactionResult.NotEnoughCurrencySpace => "You cannot hold any more gold.",
            _ => "The game refused the change.",
        };
    }

    /// <summary>Writes the save now, so a trade that was just applied is on disk before the server is told.</summary>
    public static void SaveNow(Game game) => game.LocalSave();
}
