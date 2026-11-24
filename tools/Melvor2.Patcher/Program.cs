// Adds a tiny bootstrap to the game assembly so it loads Melvor2.ModLoader.dll at startup.
//
// Usage: Melvor2.Patcher <input game dll> <output dll>
// Exit codes: 0 patched, 2 already patched, 1 error.
//
// What it changes:
//   1. Adds a static class "Melvor2ModBootstrap" with one method, Load(), which does
//        try { string path = BaseDirectory + "Melvor2.ModLoader.dll";
//              if (!File.Exists(path)) path = <folder of the game DLL itself> + "Melvor2.ModLoader.dll";
//              AssemblyLoadContext.GetLoadContext(Assembly.GetExecutingAssembly())
//                  .LoadFromAssemblyPath(path)
//                  .GetType("Melvor2.ModLoader.Bootstrap").GetMethod("Start").Invoke(null, null); }
//        catch (Exception) { }
//   2. Inserts a call to Load() at the start of GamesByMalcs.Melvor2.Main's constructor.
// If the loader DLL is missing the catch swallows the error and the game runs unmodded.
//
// The second place to look is for when another mod loader starts the game through Godot's override.cfg
// (Melvor Mod Loader does): BaseDirectory is then that loader's folder, not the game's data folder.

using Mono.Cecil;
using Mono.Cecil.Cil;

const string BootstrapTypeName = "Melvor2ModBootstrap";
const string MainTypeName = "GamesByMalcs.Melvor2.Main";

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: Melvor2.Patcher <input game dll> <output dll>");
    return 1;
}

string input = Path.GetFullPath(args[0]);
string output = Path.GetFullPath(args[1]);

try
{
    var resolver = new DefaultAssemblyResolver();
    resolver.AddSearchDirectory(Path.GetDirectoryName(input)!);

    using var asm = AssemblyDefinition.ReadAssembly(input, new ReaderParameters
    {
        AssemblyResolver = resolver,
        ReadingMode = ReadingMode.Immediate,
        InMemory = true,
    });
    ModuleDefinition module = asm.MainModule;

    if (module.GetType(BootstrapTypeName) != null)
    {
        Console.WriteLine("Already patched.");
        return 2;
    }

    TypeDefinition main = module.GetType(MainTypeName)
        ?? throw new InvalidOperationException($"Type {MainTypeName} not found. The game may have changed.");
    MethodDefinition ctor = main.Methods.FirstOrDefault(m => m.IsConstructor && !m.IsStatic && m.Parameters.Count == 0)
        ?? throw new InvalidOperationException($"{MainTypeName} has no parameterless constructor.");

    AssemblyNameReference runtime = module.AssemblyReferences.FirstOrDefault(a => a.Name == "System.Runtime")
        ?? throw new InvalidOperationException("Game assembly does not reference System.Runtime.");

    TypeReference T(string ns, string name) => new(ns, name, module, runtime, valueType: false);
    MethodReference M(TypeReference declaring, string name, TypeReference ret, bool hasThis, params TypeReference[] ps)
    {
        var m = new MethodReference(name, ret, declaring) { HasThis = hasThis };
        foreach (TypeReference p in ps) m.Parameters.Add(new ParameterDefinition(p));
        return m;
    }

    TypeReference tString = module.TypeSystem.String;
    TypeReference tObject = module.TypeSystem.Object;
    TypeReference tVoid = module.TypeSystem.Void;
    TypeReference tAppContext = T("System", "AppContext");
    TypeReference tPath = T("System.IO", "Path");
    TypeReference tAssembly = T("System.Reflection", "Assembly");
    TypeReference tType = T("System", "Type");
    TypeReference tMethodInfo = T("System.Reflection", "MethodInfo");
    TypeReference tMethodBase = T("System.Reflection", "MethodBase");
    TypeReference tException = T("System", "Exception");

    MethodReference getBaseDir = M(tAppContext, "get_BaseDirectory", tString, false);
    MethodReference combine = M(tPath, "Combine", tString, false, tString, tString);
    MethodReference getDirName = M(tPath, "GetDirectoryName", tString, false, tString);
    MethodReference fileExists = M(T("System.IO", "File"), "Exists", module.TypeSystem.Boolean, false, tString);
    MethodReference getLocation = M(tAssembly, "get_Location", tString, true);
    // Godot loads the game (and GodotSharp, Steamworks.NET) into its own AssemblyLoadContext.
    // The loader must go into that same context; Assembly.LoadFrom would use the default context and
    // get a second, uninitialised copy of GodotSharp, which crashes on the first Godot call.
    AssemblyNameReference loaderRef = module.AssemblyReferences.FirstOrDefault(a => a.Name == "System.Runtime.Loader")!;
    if (loaderRef == null)
    {
        loaderRef = new AssemblyNameReference("System.Runtime.Loader", runtime.Version)
        {
            PublicKeyToken = runtime.PublicKeyToken,
        };
        module.AssemblyReferences.Add(loaderRef);
    }
    TypeReference tAlc = new("System.Runtime.Loader", "AssemblyLoadContext", module, loaderRef, valueType: false);
    MethodReference getExecuting = M(tAssembly, "GetExecutingAssembly", tAssembly, false);
    MethodReference getLoadContext = M(tAlc, "GetLoadContext", tAlc, false, tAssembly);
    MethodReference loadFromPath = M(tAlc, "LoadFromAssemblyPath", tAssembly, true, tString);
    MethodReference getType = M(tAssembly, "GetType", tType, true, tString);
    MethodReference getMethod = M(tType, "GetMethod", tMethodInfo, true, tString);
    MethodReference invoke = M(tMethodBase, "Invoke", tObject, true, tObject, new ArrayType(tObject));

    var bootstrap = new TypeDefinition("", BootstrapTypeName,
        TypeAttributes.NotPublic | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit,
        tObject);
    var load = new MethodDefinition("Load",
        MethodAttributes.Assembly | MethodAttributes.Static | MethodAttributes.HideBySig, tVoid);
    bootstrap.Methods.Add(load);
    module.Types.Add(bootstrap);

    ILProcessor il = load.Body.GetILProcessor();
    Instruction ret = il.Create(OpCodes.Ret);
    Instruction tryStart = il.Create(OpCodes.Call, getBaseDir);
    Instruction havePath = il.Create(OpCodes.Call, getExecuting);
    Instruction handlerStart = il.Create(OpCodes.Pop);
    load.Body.InitLocals = true;
    load.Body.Variables.Add(new VariableDefinition(tString));

    il.Append(tryStart);
    il.Append(il.Create(OpCodes.Ldstr, "Melvor2.ModLoader.dll"));
    il.Append(il.Create(OpCodes.Call, combine));
    il.Append(il.Create(OpCodes.Stloc_0));
    il.Append(il.Create(OpCodes.Ldloc_0));
    il.Append(il.Create(OpCodes.Call, fileExists));
    il.Append(il.Create(OpCodes.Brtrue, havePath));
    il.Append(il.Create(OpCodes.Call, getExecuting));
    il.Append(il.Create(OpCodes.Callvirt, getLocation));
    il.Append(il.Create(OpCodes.Call, getDirName));
    il.Append(il.Create(OpCodes.Ldstr, "Melvor2.ModLoader.dll"));
    il.Append(il.Create(OpCodes.Call, combine));
    il.Append(il.Create(OpCodes.Stloc_0));
    il.Append(havePath);
    il.Append(il.Create(OpCodes.Call, getLoadContext));
    il.Append(il.Create(OpCodes.Ldloc_0));
    il.Append(il.Create(OpCodes.Callvirt, loadFromPath));
    il.Append(il.Create(OpCodes.Ldstr, "Melvor2.ModLoader.Bootstrap"));
    il.Append(il.Create(OpCodes.Callvirt, getType));
    il.Append(il.Create(OpCodes.Ldstr, "Start"));
    il.Append(il.Create(OpCodes.Callvirt, getMethod));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Ldnull));
    il.Append(il.Create(OpCodes.Callvirt, invoke));
    il.Append(il.Create(OpCodes.Pop));
    il.Append(il.Create(OpCodes.Leave, ret));
    il.Append(handlerStart);
    il.Append(il.Create(OpCodes.Leave, ret));
    il.Append(ret);

    load.Body.ExceptionHandlers.Add(new ExceptionHandler(ExceptionHandlerType.Catch)
    {
        TryStart = tryStart,
        TryEnd = handlerStart,
        HandlerStart = handlerStart,
        HandlerEnd = ret,
        CatchType = tException,
    });

    ILProcessor ctorIl = ctor.Body.GetILProcessor();
    ctorIl.InsertBefore(ctor.Body.Instructions[0], ctorIl.Create(OpCodes.Call, load));

    asm.Write(output);
    Console.WriteLine($"Patched: {output}");
    return 0;
}
catch (Exception e)
{
    Console.Error.WriteLine("Patch failed: " + e);
    return 1;
}
