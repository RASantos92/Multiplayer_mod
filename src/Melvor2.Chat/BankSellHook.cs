using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Inventories;
using GamesByMalcs.Melvor2.Entities.Bank;
using GamesByMalcs.Melvor2.GameMenus;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// Adds a "Sell on guild market" button to the bank, under the game's own sell options for the selected item.
/// It only opens the Guild window's sell form for that item; nothing is listed until the player confirms there.
/// </summary>
internal sealed class BankSellHook
{
    private readonly GuildService _guilds;
    private readonly Action<string> _sell;
    private ulong _panelId;
    private Control? _sellOptions;
    private Button? _button;

    public BankSellHook(GuildService guilds, Action<string> sell)
    {
        _guilds = guilds;
        _sell = sell;
    }

    /// <summary>Main thread, about twice a second while a save is loaded.</summary>
    public void Tick(GameView view)
    {
        SelectedItemView? panel = Find(view.EntityViewContainer, 0);
        if (panel == null)
        {
            Forget();
            return;
        }
        if (panel.GetInstanceId() != _panelId)
        {
            Forget();
            _panelId = panel.GetInstanceId();
            Inject(panel);
        }
        Refresh();
    }

    private void Forget()
    {
        _panelId = 0;
        _sellOptions = null;
        _button = null;
    }

    /// <summary>The bank's selected-item panel, if the bank page is showing.</summary>
    private static SelectedItemView? Find(Node node, int depth)
    {
        if (!GodotObject.IsInstanceValid(node) || node.IsQueuedForDeletion()) return null;
        if (node is SelectedItemView found) return found;
        if (depth >= 8) return null;
        foreach (Node child in node.GetChildren())
        {
            SelectedItemView? inside = Find(child, depth + 1);
            if (inside != null) return inside;
        }
        return null;
    }

    private void Inject(SelectedItemView panel)
    {
        _sellOptions = panel.Get("SellOptions").As<Control>();
        if (_sellOptions == null)
        {
            ModEntry.Log("Bank sell button: the bank has no sell options in this game version.");
            return;
        }

        _button = new Button
        {
            Name = "Melvor2GuildMarketSell",
            Text = "Sell on guild market",
            ThemeTypeVariation = "TexturedButton8x",
            CustomMinimumSize = new Vector2(0, 36),
            MouseDefaultCursorShape = Control.CursorShape.PointingHand,
            FocusMode = Control.FocusModeEnum.None,
            AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled,
            Visible = false,
        };
        _button.Pressed += Pressed;
        // The game shows its sell options only while exactly one item is selected; follow it at once.
        _sellOptions.VisibilityChanged += Refresh;

        Node parent = _sellOptions.GetParent();
        parent.AddChild(_button);
        parent.MoveChild(_button, _sellOptions.GetIndex() + 1);
        ModEntry.Log("Bank sell button added.");
    }

    private BankItem? Selected()
    {
        Game? game = ModEntry.CurrentGame();
        BankEntity? bank = game == null ? null : BankAccess.Find(game);
        if (bank == null || bank.Inventory.TotalSelectedItemCount != 1) return null;
        IReadonlyItemStack? stack = bank.Inventory.GetFirstSelectedItemStack();
        return stack == null || stack.Quantity <= 0 ? null
            : new BankItem(stack.Item, stack.Quantity, BankAccess.ValueOf(stack.Item), stack.IsLocked);
    }

    private void Refresh()
    {
        if (_button == null || _sellOptions == null || !GodotObject.IsInstanceValid(_button) || !GodotObject.IsInstanceValid(_sellOptions)) return;
        try
        {
            BankItem? item = _sellOptions.Visible && _guilds.Enabled && _guilds.Guilds.Count > 0 ? Selected() : null;
            _button.Visible = item != null;
            if (item == null) return;
            string? blocked = MarketService.WhyNotSellable(item);
            _button.Disabled = blocked != null;
            _button.TooltipText = blocked ?? "Opens the guild marketplace with this item ready to list. Nothing is listed until you confirm there.";
        }
        catch (Exception e)
        {
            _button.Visible = false;
            ModEntry.Log("Bank sell button hidden after error: " + e.Message);
        }
    }

    private void Pressed()
    {
        BankItem? item = Selected();
        if (item != null && MarketService.WhyNotSellable(item) == null) _sell(item.Item.Id);
    }
}
