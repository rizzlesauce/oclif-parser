// tslint:disable interface-over-type-literal

import {Arg} from './args'
import Deps from './deps'
import * as Errors from './errors'
import * as Flags from './flags'
import {Metadata} from './metadata'
import * as Util from './util'

const m = Deps()
.add('errors', () => require('./errors') as typeof Errors)
.add('util', () => require('./util') as typeof Util)

let debug: any
try {
  if (process.env.CLI_FLAGS_DEBUG !== '1') debug = () => {}
  else
    // tslint:disable-next-line no-implicit-dependencies
    debug = require('debug')('@oclif/parser')
} catch {
  debug = () => {}
}

export type OutputArgs<T extends ParserInput['args']> = { [P in keyof T]: any }
export type OutputFlags<T extends ParserInput['flags']> = { [P in keyof T]: any }
export type ParserOutput<TFlags extends OutputFlags<any>, TArgs extends OutputArgs<any>> = {
  flags: TFlags
  args: TArgs
  argv: string[]
  raw: ParsingToken[],
  metadata: Metadata
}

export type ArgToken = { type: 'arg'; input: string }
export type FlagToken = { type: 'flag'; flag: string; input: string }
export type ParsingToken = ArgToken | FlagToken

export interface ParserInput {
  argv: string[]
  flags: Flags.Input<any>
  args: Arg<any>[]
  strict: boolean
  context: any
  '--'?: boolean
}

export class Parser<T extends ParserInput, TFlags extends OutputFlags<T['flags']>, TArgs extends OutputArgs<T['args']>> {
  private readonly argv: string[]
  private readonly raw: ParsingToken[] = []
  private readonly booleanFlags: { [k: string]: Flags.IBooleanFlag<any> }
  private readonly context: any
  private readonly metaData: any
  private currentFlag?: Flags.IOptionFlag<any>

  constructor(private readonly input: T) {
    const {pickBy} = m.util
    this.context = input.context || {}
    this.argv = input.argv.slice(0)
    this._setNames()
    this.booleanFlags = pickBy(input.flags, f => f.type === 'boolean') as any
    this.metaData = {}
  }

  public parse() {
    this._debugInput()

    const findLongFlag = (arg: string) => {
      const name = arg.slice(2)
      if (this.input.flags[name]) {
        return name
      }
      if (arg.startsWith('--no-')) {
        const flag = this.booleanFlags[arg.slice(5)]
        if (flag && flag.allowNo) return flag.name
      }
    }

    const findShortFlag = (arg: string) => {
      return Object.keys(this.input.flags).find(k => this.input.flags[k].char === arg[1])
    }

    const parseFlag = (arg: string): boolean => {
      const long = arg.startsWith('--')
      const name = long ? findLongFlag(arg) : findShortFlag(arg)
      if (!name) {
        const i = arg.indexOf('=')
        if (i !== -1) {
          const sliced = arg.slice(i + 1)
          this.argv.unshift(sliced)

          const equalsParsed = parseFlag(arg.slice(0, i))
          if (!equalsParsed) {
            this.argv.shift()
          }
          return equalsParsed
        }
        return false
      }
      const flag = this.input.flags[name]
      if (flag.type === 'option') {
        this.currentFlag = flag
        let input
        if (long || arg.length < 3) {
          input = this.argv.shift()
        } else {
          input = arg.slice(arg[2] === '=' ? 3 : 2)
        }
        if (typeof input !== 'string') {
          throw new m.errors.CLIError(`Flag --${name} expects a value`)
        }
        this.raw.push({type: 'flag', flag: flag.name, input})
      } else {
        this.raw.push({type: 'flag', flag: flag.name, input: arg})
        // push the rest of the short characters back on the stack
        if (!long && arg.length > 2) {
          this.argv.unshift(`-${arg.slice(2)}`)
        }
      }
      return true
    }
    let parsingFlags = true
    while (this.argv.length) {
      const input = this.argv.shift() as string
      if (parsingFlags && input.startsWith('-')) {
        // attempt to parse as arg
        if (this.input['--'] !== false && input === '--') {
          parsingFlags = false
          continue
        }
        if (parseFlag(input)) {
          continue
        }
        // not actually a flag if it reaches here so parse as an arg
      }
      if (parsingFlags && this.currentFlag && this.currentFlag.multiple) {
        this.raw.push({type: 'flag', flag: this.currentFlag.name, input})
        continue
      }
      // not a flag, parse as arg
      const arg = this.input.args[this._argTokens.length]
      if (arg) arg.input = input
      this.raw.push({type: 'arg', input})
      if (arg && arg.stopParsing) {
        parsingFlags = false
        continue
      }
    }
    const argv = this._argv()
    const args = this._args(argv)
    const flags = this._flags()
    this._debugOutput(argv, args, flags)
    return {
      args,
      argv,
      flags,
      raw: this.raw,
      metadata: this.metaData
    }
  }

  private _args(argv: any[]): TArgs {
    const args = {} as any
    for (let i = 0; i < this.input.args.length; i++) {
      const arg = this.input.args[i]
      args[arg.name!] = argv[i]
    }
    return args
  }

  private _flags(): TFlags {
    const flags = {} as any
    this.metaData.flags = {} as any
    for (const token of this._flagTokens) {
      const flag = this.input.flags[token.flag]
      if (!flag) throw new m.errors.CLIError(`Unexpected flag ${token.flag}`)
      if (flag.type === 'boolean') {
        if (token.input === `--no-${flag.name}`) {
          flags[token.flag] = false
        } else {
          flags[token.flag] = true
        }
        flags[token.flag] = flag.parse(flags[token.flag], this.context)
      } else {
        const input = token.input
        if (flag.options && !flag.options.includes(input)) {
          throw new m.errors.FlagInvalidOptionError(flag, input)
        }
        const value = flag.parse ? flag.parse(input, this.context) : input
        if (flag.multiple) {
          flags[token.flag] = flags[token.flag] || []
          flags[token.flag].push(value)
        } else {
          flags[token.flag] = value
        }
      }
    }
    for (const k of Object.keys(this.input.flags)) {
      const flag = this.input.flags[k]
      if (flags[k]) continue
      if (flag.type === 'option' && flag.env) {
        let input = process.env[flag.env]
        if (input) flags[k] = flag.parse(input, this.context)
      }
      if (!(k in flags) && flag.default !== undefined) {
        this.metaData.flags[k] = {setFromDefault: true}
        if (typeof flag.default === 'function') {
          flags[k] = flag.default({options: flag, flags, ...this.context})
        } else {
          flags[k] = flag.default
        }
      }
    }
    return flags
  }

  private _argv(): any[] {
    const args: any[] = []
    const tokens = this._argTokens
    for (let i = 0; i < Math.max(this.input.args.length, tokens.length); i++) {
      const token = tokens[i]
      const arg = this.input.args[i]
      if (token) {
        if (arg) {
          if (arg.options && !arg.options.includes(token.input)) {
            throw new m.errors.ArgInvalidOptionError(arg, token.input)
          }
          args[i] = arg.parse(token.input)
        } else {
          args[i] = token.input
        }
      } else {
        if ('default' in arg) {
          if (typeof arg.default === 'function') {
            args[i] = arg.default()
          } else {
            args[i] = arg.default
          }
        }
      }
    }
    return args
  }

  private _debugOutput(args: any, flags: any, argv: any) {
    if (argv.length) {
      debug('argv: %o', argv)
    }
    if (Object.keys(args).length) {
      debug('args: %o', args)
    }
    if (Object.keys(flags).length) {
      debug('flags: %o', flags)
    }
  }

  private _debugInput() {
    debug('input: %s', this.argv.join(' '))
    if (this.input.args.length) {
      debug('available args: %s', this.input.args.map(a => a.name).join(' '))
    }
    if (!Object.keys(this.input.flags).length) return
    debug(
      'available flags: %s',
      Object.keys(this.input.flags)
        .map(f => `--${f}`)
        .join(' '),
    )
  }

  private get _argTokens(): ArgToken[] {
    return this.raw.filter(o => o.type === 'arg') as ArgToken[]
  }
  private get _flagTokens(): FlagToken[] {
    return this.raw.filter(o => o.type === 'flag') as FlagToken[]
  }

  private _setNames() {
    for (const k of Object.keys(this.input.flags)) {
      this.input.flags[k].name = k
    }
  }
}
