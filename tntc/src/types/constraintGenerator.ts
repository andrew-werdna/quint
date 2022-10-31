/* ----------------------------------------------------------------------------------
 * Copyright (c) Informal Systems 2022. All rights reserved.
 * Licensed under the Apache 2.0.
 * See License.txt in the project root for license information.
 * --------------------------------------------------------------------------------- */

/**
 * Constraint generation for TNT's type system
 *
 * @author Gabriela Moreira
 *
 * @module
 */

import { IRVisitor } from '../IRVisitor'
import { TntApp, TntBool, TntConst, TntEx, TntInt, TntLambda, TntLet, TntModule, TntModuleDef, TntName, TntOpDef, TntStr, TntVar } from '../tntIr'
import { TntType, typeNames } from '../tntTypes'
import { expressionToString } from '../IRprinting'
import { Either, right, left, mergeInMany } from '@sweet-monads/either'
import { buildErrorTree, ErrorTree, Error } from '../errorTree'
import { getSignatures } from './builtinSignatures'
import { Constraint, Signature, TypeScheme } from './base'
import { Substitutions, applySubstitution } from './substitutions'
import { ScopeTree, treeFromModule } from '../scoping'
import { LookupTable, LookupTableByModule, lookupValue, newTable } from '../lookupTable'

type solvingFunctionType = (constraint: Constraint) => Either<Map<bigint, ErrorTree>, Substitutions>

// A visitor that collects types and constraints for a module's expressions
export class ConstraintGeneratorVisitor implements IRVisitor {
  // Inject dependency to allow manipulation in unit tests
  constructor(solvingFunction: solvingFunctionType, definitionsTable: LookupTableByModule) {
    this.solvingFunction = solvingFunction
    this.definitionsTable = definitionsTable
  }

  // Public values with results by expression ID
  types: Map<bigint, TntType> = new Map<bigint, TntType>()
  errors: Map<bigint, ErrorTree> = new Map<bigint, ErrorTree>()

  private solvingFunction: solvingFunctionType
  private constraints: Constraint[] = []
  private freshVarCounter: number = 0

  private context: Map<bigint, Signature> = new Map<bigint, Signature>()
  private builtinSignatures: Map<string, Signature> = getSignatures()
  private definitionsTable: LookupTableByModule

  // Track location descriptions for error tree traces
  private location: string = ''

  private currentModule?: TntModule
  private currentTable: LookupTable = newTable({})
  private currentScopeTree: ScopeTree = { value: 0n, children: [] }
  private moduleStack: TntModule[] = []

  enterModuleDef (def: TntModuleDef): void {
    this.moduleStack.push(def.module)

    this.updateCurrentModule()
  }

  exitModuleDef (_: TntModuleDef): void {
    this.moduleStack.pop()

    this.updateCurrentModule()
  }

  enterExpr (e: TntEx) {
    this.location = `Generating constraints for ${expressionToString(e)}`
  }

  enterVar (e: TntVar) {
    this.context.set(e.id, (_) => ({ type: e.type, variables: new Set() }))
  }

  enterConst (e: TntConst) {
    this.context.set(e.id, (_) => ({ type: e.type, variables: new Set() }))
  }

  //     n: t ∈ Γ
  // ----------------- (NAME)
  //  Γ ⊢ n: (t, true)
  enterName (e: TntName) {
    if (this.errors.size !== 0) {
      return
    }
    this.addToResults(e.id, this.fetchSignature(e.name, e.id, 2))
  }

  // Literals have always the same type and the empty constraint
  enterLiteral (e: TntBool | TntInt | TntStr) {
    this.addToResults(e.id, right({ kind: e.kind }))
  }

  //   op: q ∈ Γ   Γ ⊢  p0, ..., pn: (t0, c0), ..., (tn, cn)   a is fresh
  // ------------------------------------------------------------------------ (APP)
  //    Γ ⊢ op(p0, ..., pn): (a, q ~ (t0, ..., tn) => a ∧ c0 ∧ ... ∧ cn)
  exitApp (e: TntApp) {
    if (this.errors.size !== 0) {
      return
    }
    const result = this.fetchSignature(e.opcode, e.id, e.args.length)
      .chain(t1 => {
        const argsResult: Either<Error, TntType[]> = mergeInMany(e.args.map(e => this.fetchResult(e.id)))

        return argsResult
          .map((argsTypes: TntType[]): TntType => {
            const a: TntType = { kind: 'var', name: this.freshVar() }
            const t2: TntType = { kind: 'oper', args: argsTypes, res: a }
            const c: Constraint = { kind: 'eq', types: [t1, t2], sourceId: e.id }
            this.constraints.push(c)
            return a
          })
      })

    this.addToResults(e.id, result)
  }

  //    Γ ∪ {p0: t0, ..., pn: tn} ⊢ e: (te, c)    t0, ..., tn are fresh
  // ---------------------------------------------------------------------- (LAMBDA)
  //            Γ ⊢ (p0, ..., pn) => e: ((t0, ..., tn) => te, c)
  enterLambda (e: TntLambda) {
    e.params.filter(p => p !== '_').forEach(p => {
      const t: TntType = { kind: 'var', name: this.freshVar() }
      const id = lookupValue(this.currentTable, this.currentScopeTree, p, e.expr.id)?.reference
      if (id) {
        this.context.set(id, (_) => ({ type: t, variables: new Set() }))
      }
    })
  }

  exitLambda (e: TntLambda) {
    if (this.errors.size !== 0) {
      return
    }
    const result = this.fetchResult(e.expr.id)
      .chain(resultType => {
        const paramTypes = mergeInMany(e.params.map(p => this.fetchSignature(p, e.expr.id, 2)))
        return paramTypes.map((ts): TntType => {
          return { kind: 'oper', args: ts, res: resultType }
        }).mapLeft(e => {
          throw new Error(`This should be impossible: Lambda variables not found: ${e.join(', ')}`)
        })
      })

    this.addToResults(e.id, result)

    e.params.forEach(p => {
      const id = lookupValue(this.currentTable, this.currentScopeTree, p, e.expr.id)?.reference
      if (id) {
        this.context.delete(id)
      }
    })
    // TODO: delete from result
    // And I should probably merge context and results.
  }

  //   Γ ⊢ e1: (t1, c1)  s = solve(c1)     s(Γ ∪ {n: t1}) ⊢ e2: (t2, c2)
  // ------------------------------------------------------------------------ (LET-OPDEF)
  //               Γ ⊢ val n = e1 { e2 }: (t2, c1 ∧ c2)
  exitLet (e: TntLet) {
    if (this.errors.size !== 0) {
      return
    }

    // TODO: Consider annotations, see https://github.com/informalsystems/tnt/issues/168
    // TODO: Occurs check on operator body to prevent recursion, see https://github.com/informalsystems/tnt/issues/171

    this.addToResults(e.id, this.fetchResult(e.expr.id))
  }

  exitOpDef (e: TntOpDef) {
    if (this.errors.size !== 0) {
      return
    }

    this.fetchResult(e.expr.id)
      .mapLeft(err => this.errors.set(e.id, err))
      .map(t => {
        this.addToResults(e.id, right(t))

        const constraint: Constraint = { kind: 'conjunction', constraints: this.constraints, sourceId: 0n }
        this.solvingFunction(constraint)
          .mapLeft(errors => errors.forEach((err, id) => this.errors.set(id, err)))
          .map((subs) => {
            // Apply substitution to environment
            this.types = new Map<bigint, TntType>(
              [...this.types.entries()].map(([id, te]) => [id, applySubstitution(subs, te)])
            )
          })
      })

    // Remove solved constraints
    this.constraints = []

    // Add operator type to the context
    this.fetchResult(e.id).map(operatorType => {
      this.context.set(e.id, (_) => ({ type: operatorType, variables: typeNames(operatorType) }))
    })
  }

  private addToResults (exprId: bigint, result: Either<Error, TntType>) {
    result
      .mapLeft(err => this.errors.set(exprId, buildErrorTree(this.location, err)))
      .map(r => this.types.set(exprId, r))
  }

  private fetchResult (id: bigint): Either<ErrorTree, TntType> {
    const successfulResult = this.types.get(id)
    const failedResult = this.errors.get(id)
    if (failedResult) {
      return left(failedResult)
    } else if (successfulResult) {
      return right(successfulResult)
    } else {
      throw new Error(`Couldn't find any result for id ${id}`)
    }
  }

  private freshVar (): string {
    return `t${this.freshVarCounter++}`
  }

  private fetchSignature (opcode: string, scope: bigint, arity: number): Either<string, TntType> {
    // Assumes a valid number of arguments
    if (opcode === '_') {
      return right({ kind: 'var', name: this.freshVar() })
    }

    let signatureFunction: Signature
    if (this.builtinSignatures.has(opcode)) {
      signatureFunction = this.builtinSignatures.get(opcode)!
    } else {
      const id = lookupValue(this.currentTable, this.currentScopeTree, opcode, scope)?.reference
      if (!id || !this.context.has(id)) {
        throw new Error(`Signature not found for name: ${opcode}`)
      }
      signatureFunction = this.context.get(id)!
    }
    const signature = signatureFunction(arity)
    return right(this.newInstance(signature))
  }

  private newInstance (type: TypeScheme): TntType {
    const names = type.variables
    const subs: Substitutions = Array.from(names).map(name => {
      return { name: name, value: { kind: 'var', name: this.freshVar() } }
    })

    return applySubstitution(subs, type.type)
  }

  private updateCurrentModule (): void {
    if (this.moduleStack.length > 0) {
      this.currentModule = this.moduleStack[this.moduleStack.length - 1]

      const moduleTable = this.definitionsTable.get(this.currentModule!.name)!
      this.currentTable = moduleTable
      this.currentScopeTree = treeFromModule(this.currentModule)
    }
  }
}
