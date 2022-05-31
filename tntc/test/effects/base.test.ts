import { describe, it } from 'mocha'
import { assert } from 'chai'
import { Effect, unify } from '../../src/effects/base'

describe('unify', () => {
  describe('simple effects', () => {
    it('returns error for each effect updating a variable more than once', () => {
      const e1: Effect = {
        kind: 'concrete',
        read: { kind: 'concrete', vars: [] },
        update: { kind: 'concrete', vars: ['x', 'x'] },
      }

      const e2: Effect = {
        kind: 'concrete',
        read: { kind: 'concrete', vars: [] },
        update: { kind: 'union', variables: [{ kind: 'concrete', vars: ['x'] }, { kind: 'concrete', vars: ['x'] }] },
      }

      const result = unify(e1, e2)

      assert.isTrue(result.isLeft())
      const { value } = result
      assert.deepEqual(value, {
        location: "Trying to unify Update['x', 'x'] and Update['x', 'x']",
        children: [
          {
            location: "Trying to simplify effect Update['x', 'x']",
            message: 'Multiple updates of variable(s): x',
            children: [],
          },
          {
            location: "Trying to simplify effect Update['x', 'x']",
            message: 'Multiple updates of variable(s): x',
            children: [],
          },
        ],
      })
    })

    it('unifies variables with different orders', () => {
      const e1: Effect = {
        kind: 'concrete',
        read: { kind: 'concrete', vars: ['x', 'y'] },
        update: { kind: 'concrete', vars: [] },
      }

      const e2: Effect = {
        kind: 'concrete',
        read: { kind: 'concrete', vars: ['y', 'x'] },
        update: { kind: 'concrete', vars: [] },
      }

      const result = unify(e1, e2)

      assert.isTrue(result.isRight())
      if (result.isRight()) {
        const { value } = result
        assert.sameDeepMembers(value, [])
      }
    })

    it('flattens any nested unions', () => {
      const e1: Effect = { kind: 'quantified', name: 'E' }

      const e2: Effect = {
        kind: 'concrete',
        read: {
          kind: 'union',
          variables: [
            { kind: 'union', variables: [{ kind: 'quantified', name: 'r1' }, { kind: 'concrete', vars: ['x', 'y'] }] },
            { kind: 'quantified', name: 'r2' },
          ],
        },
        update: { kind: 'concrete', vars: [] },
      }

      const result = unify(e1, e2)
      assert.isTrue(result.isRight())
      if (result.isRight()) {
        const { value } = result
        assert.sameDeepMembers(value, [
          {
            kind: 'effect',
            name: 'E',
            value: {
              kind: 'concrete',
              read: {
                kind: 'union',
                variables: [
                  { kind: 'quantified', name: 'r1' },
                  { kind: 'concrete', vars: ['x', 'y'] },
                  { kind: 'quantified', name: 'r2' },
                ],
              },
              update: { kind: 'concrete', vars: [] },
            },
          },
        ])
      }
    })
  })

  describe('simple arrow effects', () => {
    const e1: Effect = {
      kind: 'arrow',
      params: [
        { kind: 'concrete', read: { kind: 'quantified', name: 'v' }, update: { kind: 'concrete', vars: [] } },
      ],
      result: { kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'quantified', name: 'v' } },
    }

    it('unifies effects with parameters', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: [] } },
        ],
        result: { kind: 'quantified', name: 'E' },
      }

      const result = unify(e1, e2)

      assert.isTrue(result.isRight())
      if (result.isRight()) {
        const { value } = result
        assert.sameDeepMembers(value, [
          { kind: 'variable', name: 'v', value: { kind: 'concrete', vars: ['x'] } },
          {
            kind: 'effect',
            name: 'E',
            value: {
              kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'concrete', vars: ['x'] },
            },
          },
        ])
      }
    })

    it('returns error when cannot unify variables', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: [] } },
        ],
        result: { kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'concrete', vars: ['y'] } },
      }

      const result = unify(e1, e2)

      assert.isTrue(result.isLeft())
      if (result.isLeft()) {
        const { value } = result
        assert.deepEqual(value, {
          location: "Trying to unify (Read[v]) => Update[v] and (Read['x']) => Update['y']",
          children: [{
            location: "Trying to unify Update['x'] and Update['y']",
            children: [{
              location: "Trying to unify variables 'x' and 'y'",
              message: 'Expected effect to act over variable(s) x instead of y',
              children: [],
            }],
          }],
        })
      }
    })

    it('returns error when there are not enough parameters', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [],
        result: { kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'concrete', vars: ['y'] } },
      }

      const result = unify(e1, e2)

      assert.isTrue(result.isLeft())
      if (result.isLeft()) {
        const { value } = result
        assert.deepEqual(value, {
          location: "Trying to unify (Read[v]) => Update[v] and () => Update['y']",
          message: 'Expected 1 arguments, got 0',
          children: [],
        })
      }
    })

    it('returns error when trying to unify with non-arrow effect', () => {
      const e2: Effect = { kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'concrete', vars: ['y'] } }

      const result = unify(e1, e2)

      assert.isTrue(result.isLeft())
      if (result.isLeft()) {
        const { value } = result
        assert.deepEqual(value, {
          location: "Trying to unify (Read[v]) => Update[v] and Update['y']",
          message: "Can't unify different types of effects",
          children: [],
        })
      }
    })
  })

  describe('nested arrow effects', () => {
    const e1: Effect = {
      kind: 'arrow',
      params: [
        {
          kind: 'arrow',
          params: [
            { kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'concrete', vars: [] } },
          ],
          result: { kind: 'quantified', name: 'E' },
        },
      ],
      result: { kind: 'quantified', name: 'E' },
    }

    it('unifies effects with parameters', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          {
            kind: 'arrow',
            params: [
              { kind: 'concrete', read: { kind: 'concrete', vars: [] }, update: { kind: 'concrete', vars: [] } },
            ],
            result: { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: [] } },
          },
        ],
        result: { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: [] } },
      }

      const result = unify(e1, e2)

      assert.isTrue(result.isRight())
      if (result.isRight()) {
        const { value } = result
        assert.sameDeepMembers(value, [
          {
            kind: 'effect',
            name: 'E',
            value: { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: [] } },
          },
        ])
      }
    })
  })

  describe('effects with multiple quantified variables', () => {
    const e1: Effect = {
      kind: 'arrow',
      params: [
        { kind: 'concrete', read: { kind: 'quantified', name: 'r1' }, update: { kind: 'quantified', name: 'u' } },
        { kind: 'concrete', read: { kind: 'quantified', name: 'r2' }, update: { kind: 'quantified', name: 'u' } },
      ],
      result: { kind: 'concrete', read: { kind: 'union', variables: [{ kind: 'quantified', name: 'r1' }, { kind: 'quantified', name: 'r2' }] }, update: { kind: 'quantified', name: 'u' } },
    }

    it('unfies with concrete and unifiable effect', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: ['x'] } },
          { kind: 'concrete', read: { kind: 'concrete', vars: ['y', 'z'] }, update: { kind: 'concrete', vars: ['x'] } },
        ],
        result: { kind: 'concrete', read: { kind: 'concrete', vars: ['x', 'y', 'z'] }, update: { kind: 'concrete', vars: ['x'] } },
      }

      const result = unify(e1, e2)
      const reversedResult = unify(e2, e1)

      assert.isTrue(result.isRight())
      if (result.isRight()) {
        const { value } = result
        assert.sameDeepMembers(value, [
          { kind: 'variable', name: 'r1', value: { kind: 'concrete', vars: ['x'] } },
          { kind: 'variable', name: 'r2', value: { kind: 'concrete', vars: ['y', 'z'] } },
          { kind: 'variable', name: 'u', value: { kind: 'concrete', vars: ['x'] } },
        ])
      }
      assert.deepEqual(result, reversedResult, 'Result should be the same regardless of the effect order in parameters')
    })

    it('returns error with incompatible effect', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'concrete', vars: ['x'] } },
          { kind: 'concrete', read: { kind: 'concrete', vars: ['y'] }, update: { kind: 'concrete', vars: ['y'] } },
        ],
        result: { kind: 'quantified', name: 'E' },
      }

      const result = unify(e1, e2)
      assert.isTrue(result.isLeft())
      if (result.isLeft()) {
        const { value } = result
        assert.deepEqual(value, {
          location: "Trying to unify (Read[r1] & Update[u], Read[r2] & Update[u]) => Read[r1, r2] & Update[u] and (Read['x'] & Update['x'], Read['y'] & Update['y']) => E",
          children: [{
            location: "Trying to unify Read[r2] & Update['x'] and Read['y'] & Update['y']",
            children: [{
              location: "Trying to unify variables 'x' and 'y'",
              message: 'Expected effect to act over variable(s) x instead of y',
              children: [],
            }],
          }],
        })
      }
    })

    it('returns partial quantified when unifying with another quantified effect', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          { kind: 'concrete', read: { kind: 'concrete', vars: ['x'] }, update: { kind: 'quantified', name: 'v' } },
          { kind: 'concrete', read: { kind: 'concrete', vars: ['y'] }, update: { kind: 'quantified', name: 'v' } },
        ],
        result: { kind: 'concrete', read: { kind: 'concrete', vars: ['x', 'y'] }, update: { kind: 'quantified', name: 'v' } },
      }

      const result = unify(e1, e2)
      assert.isTrue(result.isRight())
      if (result.isRight()) {
        const { value } = result
        assert.sameDeepMembers(value, [
          { kind: 'variable', name: 'r1', value: { kind: 'concrete', vars: ['x'] } },
          { kind: 'variable', name: 'r2', value: { kind: 'concrete', vars: ['y'] } },
          { kind: 'variable', name: 'u', value: { kind: 'quantified', name: 'v' } },
        ])
      }
    })

    it('returns error with incompatible quantified effect', () => {
      const e2: Effect = {
        kind: 'arrow',
        params: [
          { kind: 'concrete', read: { kind: 'concrete', vars: ['y'] }, update: { kind: 'concrete', vars: ['x'] } },
          { kind: 'concrete', read: { kind: 'concrete', vars: ['z'] }, update: { kind: 'concrete', vars: ['x'] } },
        ],
        result: { kind: 'concrete', read: { kind: 'concrete', vars: ['y'] }, update: { kind: 'quantified', name: 'u' } },
      }

      const result = unify(e1, e2)
      assert.isTrue(result.isLeft())
      if (result.isLeft()) {
        const { value } = result
        assert.deepEqual(value, {
          location: "Trying to unify (Read[r1] & Update[u], Read[r2] & Update[u]) => Read[r1, r2] & Update[u] and (Read['y'] & Update['x'], Read['z'] & Update['x']) => Read['y'] & Update[u]",
          children: [{
            location: "Trying to unify Read['y', 'z'] & Update['x'] and Read['y'] & Update['x']",
            children: [{
              location: "Trying to unify variables 'y', 'z' and 'y'",
              message: 'Expected effect to act over variable(s) y,z instead of y',
              children: [],
            }],
          }],
        })
      }
    })

    it('returns error when unifying union with another union', () => {
      const e1: Effect = {
        kind: 'concrete',
        read: { kind: 'union', variables: [{ kind: 'quantified', name: 'r1' }, { kind: 'quantified', name: 'r2' }] },
        update: { kind: 'concrete', vars: [] },
      }
      const e2: Effect = {
        kind: 'concrete',
        read: { kind: 'union', variables: [{ kind: 'concrete', vars: ['x', 'y'] }, { kind: 'quantified', name: 'r' }] },
        update: { kind: 'concrete', vars: [] },
      }

      const result = unify(e1, e2)
      assert.isTrue(result.isLeft())
      if (result.isLeft()) {
        const { value } = result
        assert.deepEqual(value, {
          location: "Trying to unify Read[r1, r2] and Read['x', 'y', r]",
          children: [{
            location: "Trying to unify variables r1, r2 and r, 'x', 'y'",
            message: 'Unification for unions of variables is not implemented',
            children: [],
          }],
        })
      }
    })
  })
})