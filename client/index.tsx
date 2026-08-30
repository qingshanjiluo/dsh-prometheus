import { defineComponent, PropType } from 'vue';

export default defineComponent({
  props: {
    config: {
      type: Object as PropType<{
        enabled: boolean;
        url: string;
        timeout: number;
      }>,
      required: true,
    },
    onChange: {
      type: Function as PropType<(config: Record<string, any>) => void>,
      required: true,
    },
  },
  setup(props) {
    const update = (key: string, value: any) => {
      props.onChange({ ...props.config, [key]: value });
    };

    return () => (
      <div class="dsh-prometheus-settings">
        <h3>Prometheus 设置</h3>
        <label>
          <input
            type="checkbox"
            checked={props.config.enabled}
            onChange={(e) => update('enabled', (e.target as HTMLInputElement).checked)}
          />
          启用
        </label>
        <label>
          URL
          <input
            type="text"
            value={props.config.url}
            placeholder="http://localhost:9090"
            onInput={(e) => update('url', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          超时 (ms)
          <input
            type="number"
            value={props.config.timeout}
            min={1000}
            max={60000}
            onInput={(e) => update('timeout', Number((e.target as HTMLInputElement).value))}
          />
        </label>
      </div>
    );
  },
});
