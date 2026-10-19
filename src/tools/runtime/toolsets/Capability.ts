export class Capability {
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  get promptFragment(): string {
    throw new Error('Subclass must implement promptFragment');
  }

  get tools(): string[] {
    return [];
  }

  buildContext(_context: unknown): string | null {
    return null;
  }

  /**
   * 步骤前钩子：保留的公开扩展点，基类签名不变，但当前没有任何调用方。
   *
   * 运行循环不调用此钩子：自 L5-P2（I48）起 AgentRuntime 不再在每轮开始时驱动它（旧调用每轮为每个
   * 能力复制整份消息历史，只为传给空函数）。子类覆盖不会生效，运行时也不会为此记录诊断。
   * 宿主需要逐轮观察时，改为通过 `runtime.hookSystem` 订阅 `agent:iteration:before` /
   * `agent:iteration:after` Hook 事件；逐个工具调用可订阅 `tool:execute:before` / `tool:execute:after`。
   */
  onBeforeStep(_stepState: unknown) {}

  /**
   * 步骤后钩子：保留的公开扩展点，基类签名不变，但当前没有任何调用方。
   *
   * 运行循环不调用此钩子：自 L5-P2（I48）起 AgentRuntime 不再在工具轮结束后驱动它；本轮步骤摘要只交给
   * 运行时状态机。子类覆盖不会生效，运行时也不会为此记录诊断。
   * 宿主需要逐轮观察时，改为通过 `runtime.hookSystem` 订阅 `agent:iteration:after` Hook 事件
   * （payload 含 iteration、hadToolCalls、hadText）；逐个工具回执可订阅 `tool:execute:after`。
   */
  onAfterStep(_stepResult: unknown) {}
}
