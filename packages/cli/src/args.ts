export interface CliArgs {
  print: boolean;
  continue: boolean;
  session?: string;
  model?: string;
  profile?: string;
  maxTurns?: number;
  thinking?: number;
  autoCompact: boolean;
  extensions: string[];
  usage: boolean;
  help: boolean;
  prompt: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    continue: false,
    autoCompact: true,
    extensions: [],
    usage: false,
    help: false,
    prompt: '',
  };
  const positional: string[] = [];
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
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) throw new Error('--max-turns requires an integer >= 1');
        args.maxTurns = value;
        break;
      }
      case '--thinking': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) throw new Error('--thinking requires a token budget >= 1');
        args.thinking = value;
        break;
      }
      case '--ext':
        args.extensions.push(next());
        break;
      case '--no-auto-compact':
        args.autoCompact = false;
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
  -c, --continue       continue the most recent session in this directory
  --session <id|path>  open a specific session
  --model <name>       override the model
  --profile <name>     provider profile (anthropic | openai | from ~/.config/pi/config.json)
  --max-turns <n>      cap model calls per input (default 40)
  --thinking <tokens>  enable extended thinking with this token budget (Anthropic models)
  --no-auto-compact    never summarize automatically when the context window fills
  --ext <path>         load a TypeScript/JavaScript extension module (repeatable)
  --usage              print a JSON usage summary to stderr when done
  -h, --help           show this help

interactive slash commands: /help /tokens /model /session /branch /compact /exit
prompt templates: .agent/commands/*.md and ~/.agent/commands/*.md become /<name> commands`;
