/**
 * Host adapter for PHOSPHOR-SHEET commands.
 *
 * The spreadsheet control module does not receive VM capabilities directly.
 * A host implements this narrow interface and explicitly chooses which
 * operations are exposed.
 */

import type {
  ControlHandlers, ValidatedControlCommand,
} from './phosphor-control.ts';

export interface SheetControlHost {
  inspect?(target: string, args: Record<string, unknown>): unknown | Promise<unknown>;
  run?(target: string, maxSteps: number): unknown | Promise<unknown>;
  pause?(target: string): unknown | Promise<unknown>;
  step?(target: string, count: number): unknown | Promise<unknown>;
  reset?(target: string): unknown | Promise<unknown>;
  call?(target: string, name: string, args: number[]): unknown | Promise<unknown>;
  replay?(args: Record<string, unknown>): unknown | Promise<unknown>;
  exportSheet?(format: 'xlsx' | 'xml' | 'csv', sheet?: string): unknown | Promise<unknown>;
  applyOptimization?(target: string, variant: string): unknown | Promise<unknown>;
}

function intArg(command: ValidatedControlCommand, key: string, fallback: number): number {
  const value = command.args[key];
  return typeof value === 'number' ? value : fallback;
}

export function controlHandlersFromHost(host: SheetControlHost): ControlHandlers {
  const handlers: ControlHandlers = {};
  if (host.inspect) handlers['vm:inspect'] = command => host.inspect!(command.target, command.args);
  if (host.run) handlers['vm:run'] = command => host.run!(
    command.target,
    intArg(command, 'maxSteps', intArg(command, 'max_steps', 1000)),
  );
  if (host.pause) handlers['vm:pause'] = command => host.pause!(command.target);
  if (host.step) handlers['vm:step'] = command => host.step!(command.target, intArg(command, 'count', 1));
  if (host.reset) handlers['vm:reset'] = command => host.reset!(command.target);
  if (host.call) handlers['vm:call'] = command => host.call!(
    command.target,
    String(command.args.name ?? command.args.function ?? ''),
    (command.args.args as number[] | undefined) ?? [],
  );
  if (host.replay) handlers['stream:replay'] = command => host.replay!(command.args);
  if (host.exportSheet) handlers['sheet:export'] = command => host.exportSheet!(
    (command.args.format as 'xlsx' | 'xml' | 'csv' | undefined) ?? 'xlsx',
    typeof command.args.sheet === 'string' ? command.args.sheet : undefined,
  );
  if (host.applyOptimization) handlers['wasm:apply_optimization'] = command => host.applyOptimization!(
    command.target,
    String(command.args.variant ?? ''),
  );
  return handlers;
}
