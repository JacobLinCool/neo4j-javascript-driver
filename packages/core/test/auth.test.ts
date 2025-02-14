/**
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import auth from '../src/auth'

describe('auth', () => {
  test('.bearer()', () => {
    expect(auth.bearer('==Qyahiadakkda')).toEqual({ scheme: 'bearer', credentials: '==Qyahiadakkda' })
  })

  test.each([
    [
      ['user', 'pass', 'realm', 'scheme', { param: 'param' }],
      {
        scheme: 'scheme',
        principal: 'user',
        credentials: 'pass',
        realm: 'realm',
        parameters: { param: 'param' }
      }
    ],
    [
      ['user', '', '', 'scheme', {}],
      {
        scheme: 'scheme',
        principal: 'user'
      }
    ],
    [
      ['user', undefined, undefined, 'scheme', undefined],
      {
        scheme: 'scheme',
        principal: 'user'
      }
    ],
    [
      ['user', null, null, 'scheme', null],
      {
        scheme: 'scheme',
        principal: 'user'
      }
    ]
  ])('.custom()', (args, output) => {
    expect(auth.custom.apply(auth, args)).toEqual(output)
  })
})
