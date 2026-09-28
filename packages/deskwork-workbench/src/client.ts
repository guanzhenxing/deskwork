/**
 * The client half of the Deskwork workbench bundle: a sidebar entry whose
 * panel is an empty Deskwork placeholder. This file must stay a plain script
 * (no import/export) wrapped in the ModuleLoader bundle format the web client
 * serves through /plugins — the factory's `require` resolves the client
 * module table (react/jsx-runtime is a baseline external), never Node, and
 * the exported shape is a plain cordis plugin ({ inject, apply }).
 */
interface ModuleLoaderDefinition {
  id: string
  factory: (require: (id: string) => unknown) => unknown
}
interface ModuleLoader {
  load(definition: ModuleLoaderDefinition): void
}
/** The narrow slice of the client cordis context this plugin touches. */
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
  id: '@deskwork/workbench',
  factory: (require: (id: string) => unknown) => {
    const module = { exports: {} as Record<string, unknown> }
    const jsx = (require('react/jsx-runtime') as JsxRuntime).jsx

    const PANEL_ID = 'deskwork'

    function WorkbenchPanel(): unknown {
      return jsx('div', {
        style: {
          display: 'flex',
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          color: 'var(--dsh-text-secondary, #888888)',
        },
        children: 'Deskwork 工作台（空面板占位）',
      })
    }

    function WorkbenchIcon({ size }: { size?: number }): unknown {
      return jsx('svg', {
        width: size ?? 18,
        height: size ?? 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        children: [
          jsx('rect', { x: 3, y: 3, width: 8, height: 8, rx: 1.5 }),
          jsx('rect', { x: 13, y: 3, width: 8, height: 8, rx: 1.5 }),
          jsx('rect', { x: 3, y: 13, width: 8, height: 8, rx: 1.5 }),
          jsx('rect', { x: 13, y: 13, width: 8, height: 8, rx: 1.5 }),
        ],
      })
    }

    const inject = ['slots']
    function apply(ctx: WorkbenchClientContext): void {
      // The panel: the layout's root `main` keyed slot, addressed by PANEL_ID.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, WorkbenchPanel),
      )
      // The entry: the shell's root `sidebar.panellist` list slot, whose id
      // selects the panel registered above.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'Deskwork' },
          WorkbenchIcon,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
