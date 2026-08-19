export interface CliArgs {
  print: boolean;
  json: boolean;
  continue: boolean;
  session?: string;
  model?: string;
  profile?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxToolOutputBytes?: number;
  maxTimeMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  trustProject: boolean;
  allowHostBash: boolean;
  thinking?: number;
  autoCompact: boolean;
  flailGuard: boolean;
  offload: boolean;
  audit?: string;
  telemetry?: string;
  extensions: string[];
  usage: boolean;
  help: boolean;
  prompt: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    json: false,
    continue: false,
    autoCompact: true,
    flailGuard: true,
    offload: true,
    trustProject: false,
    allowHostBash: false,
    extensions: [],
    usage: false,
    help: false,
    prompt: '',
  };
  const positional: string[] = [];
  const positiveInteger = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} requires an integer >= 1`);
    return value;
  };
  const integerAtLeast = (flag: string, raw: string, minimum: number): number => {
    const value = positiveInteger(flag, raw);
    if (value < minimum) throw new Error(`${flag} requires an integer >= ${minimum}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '-p':
      case '--print':
        args.print = true;
        break;
      case '--json':
        args.json = true;
        args.print = true;
        break;
      case '-c':
      case '--continue':
        args.continue = true;
        break;
      case '--session':
        args.session = next();
        break;
      case '--model':
        args.model = next();
        break;
      case '--profile':
        args.profile = next();
        break;
      case '--max-turns': {
        args.maxTurns = positiveInteger('--max-turns', next());
        break;
      }
      case '--max-tool-calls': {
        args.maxToolCalls = positiveInteger('--max-tool-calls', next());
        break;
      }
      case '--max-tool-output-bytes': {
        args.maxToolOutputBytes = integerAtLeast('--max-tool-output-bytes', next(), 256);
        break;
      }
      case '--max-time': {
        const seconds = positiveInteger('--max-time', next());
        if (seconds > 2_147_483) throw new Error('--max-time is too large for the runtime timer');
        args.maxTimeMs = seconds * 1_000;
        break;
      }
      case '--max-input-tokens': {
        args.maxInputTokens = positiveInteger('--max-input-tokens', next());
        break;
      }
      case '--max-output-tokens': {
        args.maxOutputTokens = positiveInteger('--max-output-tokens', next());
        break;
      }
      case '--max-total-tokens': {
        args.maxTotalTokens = positiveInteger('--max-total-tokens', next());
        break;
      }
      case '--thinking': {
        const value = Number(next());
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('--thinking requires a token budget >= 1');
        args.thinking = value;
        break;
      }
      case '--ext':
        args.extensions.push(next());
        break;
      case '--no-auto-compact':
        args.autoCompact = false;
        break;
      case '--no-flail-guard':
        args.flailGuard = false;
        break;
      case '--no-offload':
        args.offload = false;
        break;
      case '--trust-project':
        args.trustProject = true;
        break;
      case '--allow-host-bash':
        args.allowHostBash = true;
        break;
      case '--audit': {
        const peek = argv[i + 1];
        args.audit = peek !== undefined && !peek.startsWith('-') ? argv[++i]! : 'latest';
        break;
      }
      case '--telemetry':
        args.telemetry = next();
        break;
      case '--usage':
        args.usage = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        // an unknown flag must not silently become prompt text
        if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown flag ${arg} — see pi --help`);
        positional.push(arg);
    }
  }
  args.prompt = positional.join(' ');
  return args;
}

export const HELP = `pi — minimal coding agent

usage: pi [options] [prompt]

options:
  -p, --print          headless: run the prompt, print the final reply to stdout, exit
  --json               headless JSONL event stream on stdout (implies --print)
  -c, --continue       continue the most recent session in this directory
  --session <id|path>  open a specific session
  --model <name>       override the model
  --profile <name>     provider profile (anthropic | openai | from ~/.config/pi/config.json)
  --max-turns <n>      cap model calls per input (default 40)
  --max-tool-calls <n> cap tool executions per input (default 100)
  --max-tool-output-bytes <n> cap retained output from each tool call
  --max-time <seconds> cap wall time per input (default 1800)
  --max-input-tokens <n>  stop after the provider-reported input-token budget
  --max-output-tokens <n> stop after the provider-reported output-token budget
  --max-total-tokens <n>  stop after the combined provider-reported token budget
  --thinking <tokens>  enable extended thinking with this token budget (Anthropic models)
  --no-auto-compact    never summarize automatically when the context window fills
  --no-flail-guard     disable the doom-loop guard (nudge/stop on repeated tool failures)
  --no-offload         keep old bulky tool outputs inline instead of offloading to disk
  --trust-project      load repository AGENTS.md, skill index, and prompt templates
  --allow-host-bash    expose unsandboxed host bash (dangerous; environment is sanitized)
  --audit [id|path]    print a per-request token-usage audit (default: latest here)
  --telemetry <path>   append redacted versioned runtime spans/events as owner-only JSONL
  --ext <path>         load a compiled JavaScript extension module (repeatable)
  --usage              print a JSON usage summary to stderr when done
  -h, --help           show this help

interactive slash commands: /help /tokens /model /session /branch /compact /exit
prompt templates: ~/.agent/commands/*.md always; project .agent/commands/*.md requires --trust-project`;
