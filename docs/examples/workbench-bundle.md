# 样例：把客户端界面注册进官方 UI

本仓库在收敛为纯壳之前，曾带一个工作台 bundle（`packages/deskwork-workbench`）。该包已删除，但它是**唯一一份"bundle 如何注册进官方 Web 客户端插槽"的可用样例**，因此把契约留在这里。

适用范围：将来若要在 `deskwork` profile 里加产品界面，照这份样例写 bundle，不要再凭空摸索插槽名。

## 1. 一个客户端 bundle 需要三件东西

| 件           | 作用                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| `package.json` | 声明 `dsh.bundle.patch` 让 Loader 加载它；声明 `dsh.client.platform: web` 让客户端半进入浏览器名单 |
| `cordis.patch.yml` | 一条 `insert` 记录，把 bundle 作为一个 Loader 行插进组合             |
| 客户端脚本   | 一个符合 ModuleLoader 包装格式的普通脚本，导出 `{ inject, apply }`        |

### package.json

```json
{
  "name": "@example/workbench",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib/**/*.js", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

### cordis.patch.yml

```yaml
# 把 bundle 作为 Loader 行插入：该行让 host 半（即使为空）可被寻址，
# 同时把 dsh.client 半放进浏览器名单，由 client-modules 的 host 半扫描进
# window.__DSH_BOOT__。
- insert:
    - id: example-workbench
      name: '@example/workbench'
```

### 客户端脚本

必须保持为**普通脚本**：没有 `import`，也没有 `export`。

```ts
interface ModuleLoaderDefinition {
  id: string
  factory: (require: (id: string) => unknown) => unknown
}
interface ModuleLoader {
  load(definition: ModuleLoaderDefinition): void
}
/** 该插件实际触及的客户端 cordis 上下文切片。 */
interface WorkbenchClientContext {
  slots: {
    inject: (name: string, factory: () => unknown) => void
    register: (definition: Record<string, unknown>, component: unknown) => unknown
  }
}
interface JsxRuntime {
  jsx: (type: string, props: Record<string, unknown>) => unknown
}

const loader = (globalThis as unknown as { __ModuleLoader__: ModuleLoader }).__ModuleLoader__

loader.load({
  id: '@example/workbench',
  factory: (require: (id: string) => unknown) => {
    const module = { exports: {} as Record<string, unknown> }
    const jsx = (require('react/jsx-runtime') as JsxRuntime).jsx

    const PANEL_ID = 'example'

    function WorkbenchPanel(): unknown {
      return jsx('div', { style: { display: 'flex', flex: 1 }, children: '面板内容' })
    }

    function WorkbenchIcon({ size }: { size?: number }): unknown {
      return jsx('svg', {
        width: size ?? 18,
        height: size ?? 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        children: [jsx('rect', { x: 3, y: 3, width: 8, height: 8, rx: 1.5 })],
      })
    }

    const inject = ['slots']
    function apply(ctx: WorkbenchClientContext): void {
      // 面板：布局根部的 `main` 键控插槽，用 PANEL_ID 寻址。
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, WorkbenchPanel))
      // 入口：壳层根部的 `sidebar.panellist` 列表插槽，其 id 指向上面的面板。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'Example' },
          WorkbenchIcon,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
```

## 2. 契约要点

- factory 里的 `require` 解析的是**客户端模块表**，不是 Node；`react/jsx-runtime` 是基线外部依赖，可直接用。
- 导出的形状就是一个普通 cordis 插件：`{ inject, apply }`。
- 插槽用两个：`main` 是键控插槽（承载面板本体），`sidebar.panellist` 是列表插槽（承载侧栏入口），两者用同一个 `PANEL_ID` 关联。
- host 半（`index.ts` 的 `apply`）写空函数即可；它的唯一作用是让 Loader 行可解析。
- bundle 装进 profile 后由 `dsh.profile.bundles` 决定加载顺序，产品代码不应假定自己最先或最后加载。

## 3. 相关文档

- [架构](../architecture.md)：进程与信任边界
- [宿主控制协议](../protocols/host-control.md)：壳与 Host 的通道
