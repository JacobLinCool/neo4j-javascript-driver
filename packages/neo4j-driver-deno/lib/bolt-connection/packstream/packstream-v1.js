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
import { utf8 } from '../channel/index.js'
import { functional } from '../lang/index.js'
import { Structure } from './structure.js'
import {
  newError,
  error,
  int,
  isInt,
  Integer
} from '../../core/index.ts'

const { PROTOCOL_ERROR } = error

const TINY_STRING = 0x80
const TINY_LIST = 0x90
const TINY_MAP = 0xa0
const TINY_STRUCT = 0xb0
const NULL = 0xc0
const FLOAT_64 = 0xc1
const FALSE = 0xc2
const TRUE = 0xc3
const INT_8 = 0xc8
const INT_16 = 0xc9
const INT_32 = 0xca
const INT_64 = 0xcb
const STRING_8 = 0xd0
const STRING_16 = 0xd1
const STRING_32 = 0xd2
const LIST_8 = 0xd4
const LIST_16 = 0xd5
const LIST_32 = 0xd6
const BYTES_8 = 0xcc
const BYTES_16 = 0xcd
const BYTES_32 = 0xce
const MAP_8 = 0xd8
const MAP_16 = 0xd9
const MAP_32 = 0xda
const STRUCT_8 = 0xdc
const STRUCT_16 = 0xdd

/**
 * Class to pack
 * @access private
 */
class Packer {
  /**
   * @constructor
   * @param {Chunker} channel the chunker backed by a network channel.
   */
  constructor (channel) {
    this._ch = channel
    this._byteArraysSupported = true
  }

  /**
   * Creates a packable function out of the provided value
   * @param x the value to pack
   * @returns Function
   */
  packable (x, dehydrateStruct = functional.identity) {
    try {
      x = dehydrateStruct(x)
    } catch (ex) {
      return () => { throw ex }
    }

    if (x === null) {
      return () => this._ch.writeUInt8(NULL)
    } else if (x === true) {
      return () => this._ch.writeUInt8(TRUE)
    } else if (x === false) {
      return () => this._ch.writeUInt8(FALSE)
    } else if (typeof x === 'number') {
      return () => this.packFloat(x)
    } else if (typeof x === 'string') {
      return () => this.packString(x)
    } else if (typeof x === 'bigint') {
      return () => this.packInteger(int(x))
    } else if (isInt(x)) {
      return () => this.packInteger(x)
    } else if (x instanceof Int8Array) {
      return () => this.packBytes(x)
    } else if (x instanceof Array) {
      return () => {
        this.packListHeader(x.length)
        for (let i = 0; i < x.length; i++) {
          this.packable(x[i] === undefined ? null : x[i], dehydrateStruct)()
        }
      }
    } else if (isIterable(x)) {
      return this.packableIterable(x, dehydrateStruct)
    } else if (x instanceof Structure) {
      const packableFields = []
      for (let i = 0; i < x.fields.length; i++) {
        packableFields[i] = this.packable(x.fields[i], dehydrateStruct)
      }
      return () => this.packStruct(x.signature, packableFields)
    } else if (typeof x === 'object') {
      return () => {
        const keys = Object.keys(x)

        let count = 0
        for (let i = 0; i < keys.length; i++) {
          if (x[keys[i]] !== undefined) {
            count++
          }
        }
        this.packMapHeader(count)
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          if (x[key] !== undefined) {
            this.packString(key)
            this.packable(x[key], dehydrateStruct)()
          }
        }
      }
    } else {
      return this._nonPackableValue(`Unable to pack the given value: ${x}`)
    }
  }

  packableIterable (iterable, dehydrateStruct) {
    try {
      const array = Array.from(iterable)
      return this.packable(array, dehydrateStruct)
    } catch (e) {
      // handle errors from iterable to array conversion
      throw newError(`Cannot pack given iterable, ${e.message}: ${iterable}`)
    }
  }

  /**
   * Packs a struct
   * @param signature the signature of the struct
   * @param packableFields the fields of the struct, make sure you call `packable on all fields`
   */
  packStruct (signature, packableFields) {
    packableFields = packableFields || []
    this.packStructHeader(packableFields.length, signature)
    for (let i = 0; i < packableFields.length; i++) {
      packableFields[i]()
    }
  }

  packInteger (x) {
    const high = x.high
    const low = x.low

    if (x.greaterThanOrEqual(-0x10) && x.lessThan(0x80)) {
      this._ch.writeInt8(low)
    } else if (x.greaterThanOrEqual(-0x80) && x.lessThan(-0x10)) {
      this._ch.writeUInt8(INT_8)
      this._ch.writeInt8(low)
    } else if (x.greaterThanOrEqual(-0x8000) && x.lessThan(0x8000)) {
      this._ch.writeUInt8(INT_16)
      this._ch.writeInt16(low)
    } else if (x.greaterThanOrEqual(-0x80000000) && x.lessThan(0x80000000)) {
      this._ch.writeUInt8(INT_32)
      this._ch.writeInt32(low)
    } else {
      this._ch.writeUInt8(INT_64)
      this._ch.writeInt32(high)
      this._ch.writeInt32(low)
    }
  }

  packFloat (x) {
    this._ch.writeUInt8(FLOAT_64)
    this._ch.writeFloat64(x)
  }

  packString (x) {
    const bytes = utf8.encode(x)
    const size = bytes.length
    if (size < 0x10) {
      this._ch.writeUInt8(TINY_STRING | size)
      this._ch.writeBytes(bytes)
    } else if (size < 0x100) {
      this._ch.writeUInt8(STRING_8)
      this._ch.writeUInt8(size)
      this._ch.writeBytes(bytes)
    } else if (size < 0x10000) {
      this._ch.writeUInt8(STRING_16)
      this._ch.writeUInt8((size / 256) >> 0)
      this._ch.writeUInt8(size % 256)
      this._ch.writeBytes(bytes)
    } else if (size < 0x100000000) {
      this._ch.writeUInt8(STRING_32)
      this._ch.writeUInt8(((size / 16777216) >> 0) % 256)
      this._ch.writeUInt8(((size / 65536) >> 0) % 256)
      this._ch.writeUInt8(((size / 256) >> 0) % 256)
      this._ch.writeUInt8(size % 256)
      this._ch.writeBytes(bytes)
    } else {
      throw newError('UTF-8 strings of size ' + size + ' are not supported')
    }
  }

  packListHeader (size) {
    if (size < 0x10) {
      this._ch.writeUInt8(TINY_LIST | size)
    } else if (size < 0x100) {
      this._ch.writeUInt8(LIST_8)
      this._ch.writeUInt8(size)
    } else if (size < 0x10000) {
      this._ch.writeUInt8(LIST_16)
      this._ch.writeUInt8(((size / 256) >> 0) % 256)
      this._ch.writeUInt8(size % 256)
    } else if (size < 0x100000000) {
      this._ch.writeUInt8(LIST_32)
      this._ch.writeUInt8(((size / 16777216) >> 0) % 256)
      this._ch.writeUInt8(((size / 65536) >> 0) % 256)
      this._ch.writeUInt8(((size / 256) >> 0) % 256)
      this._ch.writeUInt8(size % 256)
    } else {
      throw newError('Lists of size ' + size + ' are not supported')
    }
  }

  packBytes (array) {
    if (this._byteArraysSupported) {
      this.packBytesHeader(array.length)
      for (let i = 0; i < array.length; i++) {
        this._ch.writeInt8(array[i])
      }
    } else {
      throw newError(
        'Byte arrays are not supported by the database this driver is connected to'
      )
    }
  }

  packBytesHeader (size) {
    if (size < 0x100) {
      this._ch.writeUInt8(BYTES_8)
      this._ch.writeUInt8(size)
    } else if (size < 0x10000) {
      this._ch.writeUInt8(BYTES_16)
      this._ch.writeUInt8(((size / 256) >> 0) % 256)
      this._ch.writeUInt8(size % 256)
    } else if (size < 0x100000000) {
      this._ch.writeUInt8(BYTES_32)
      this._ch.writeUInt8(((size / 16777216) >> 0) % 256)
      this._ch.writeUInt8(((size / 65536) >> 0) % 256)
      this._ch.writeUInt8(((size / 256) >> 0) % 256)
      this._ch.writeUInt8(size % 256)
    } else {
      throw newError('Byte arrays of size ' + size + ' are not supported')
    }
  }

  packMapHeader (size) {
    if (size < 0x10) {
      this._ch.writeUInt8(TINY_MAP | size)
    } else if (size < 0x100) {
      this._ch.writeUInt8(MAP_8)
      this._ch.writeUInt8(size)
    } else if (size < 0x10000) {
      this._ch.writeUInt8(MAP_16)
      this._ch.writeUInt8((size / 256) >> 0)
      this._ch.writeUInt8(size % 256)
    } else if (size < 0x100000000) {
      this._ch.writeUInt8(MAP_32)
      this._ch.writeUInt8(((size / 16777216) >> 0) % 256)
      this._ch.writeUInt8(((size / 65536) >> 0) % 256)
      this._ch.writeUInt8(((size / 256) >> 0) % 256)
      this._ch.writeUInt8(size % 256)
    } else {
      throw newError('Maps of size ' + size + ' are not supported')
    }
  }

  packStructHeader (size, signature) {
    if (size < 0x10) {
      this._ch.writeUInt8(TINY_STRUCT | size)
      this._ch.writeUInt8(signature)
    } else if (size < 0x100) {
      this._ch.writeUInt8(STRUCT_8)
      this._ch.writeUInt8(size)
      this._ch.writeUInt8(signature)
    } else if (size < 0x10000) {
      this._ch.writeUInt8(STRUCT_16)
      this._ch.writeUInt8((size / 256) >> 0)
      this._ch.writeUInt8(size % 256)
    } else {
      throw newError('Structures of size ' + size + ' are not supported')
    }
  }

  disableByteArrays () {
    this._byteArraysSupported = false
  }

  _nonPackableValue (message) {
    return () => {
      throw newError(message, PROTOCOL_ERROR)
    }
  }
}

/**
 * Class to unpack
 * @access private
 */
class Unpacker {
  /**
   * @constructor
   * @param {boolean} disableLosslessIntegers if this unpacker should convert all received integers to native JS numbers.
   * @param {boolean} useBigInt if this unpacker should convert all received integers to Bigint
   */
  constructor (disableLosslessIntegers = false, useBigInt = false) {
    this._disableLosslessIntegers = disableLosslessIntegers
    this._useBigInt = useBigInt
  }

  unpack (buffer, hydrateStructure = functional.identity) {
    const marker = buffer.readUInt8()
    const markerHigh = marker & 0xf0
    const markerLow = marker & 0x0f

    if (marker === NULL) {
      return null
    }

    const boolean = this._unpackBoolean(marker)
    if (boolean !== null) {
      return boolean
    }

    const numberOrInteger = this._unpackNumberOrInteger(marker, buffer)
    if (numberOrInteger !== null) {
      if (isInt(numberOrInteger)) {
        if (this._useBigInt) {
          return numberOrInteger.toBigInt()
        } else if (this._disableLosslessIntegers) {
          return numberOrInteger.toNumberOrInfinity()
        }
      }
      return numberOrInteger
    }

    const string = this._unpackString(marker, markerHigh, markerLow, buffer)
    if (string !== null) {
      return string
    }

    const list = this._unpackList(marker, markerHigh, markerLow, buffer, hydrateStructure)
    if (list !== null) {
      return list
    }

    const byteArray = this._unpackByteArray(marker, buffer)
    if (byteArray !== null) {
      return byteArray
    }

    const map = this._unpackMap(marker, markerHigh, markerLow, buffer, hydrateStructure)
    if (map !== null) {
      return map
    }

    const struct = this._unpackStruct(marker, markerHigh, markerLow, buffer, hydrateStructure)
    if (struct !== null) {
      return struct
    }

    throw newError('Unknown packed value with marker ' + marker.toString(16))
  }

  unpackInteger (buffer) {
    const marker = buffer.readUInt8()
    const result = this._unpackInteger(marker, buffer)
    if (result == null) {
      throw newError(
        'Unable to unpack integer value with marker ' + marker.toString(16)
      )
    }
    return result
  }

  _unpackBoolean (marker) {
    if (marker === TRUE) {
      return true
    } else if (marker === FALSE) {
      return false
    } else {
      return null
    }
  }

  _unpackNumberOrInteger (marker, buffer) {
    if (marker === FLOAT_64) {
      return buffer.readFloat64()
    } else {
      return this._unpackInteger(marker, buffer)
    }
  }

  _unpackInteger (marker, buffer) {
    if (marker >= 0 && marker < 128) {
      return int(marker)
    } else if (marker >= 240 && marker < 256) {
      return int(marker - 256)
    } else if (marker === INT_8) {
      return int(buffer.readInt8())
    } else if (marker === INT_16) {
      return int(buffer.readInt16())
    } else if (marker === INT_32) {
      const b = buffer.readInt32()
      return int(b)
    } else if (marker === INT_64) {
      const high = buffer.readInt32()
      const low = buffer.readInt32()
      return new Integer(low, high)
    } else {
      return null
    }
  }

  _unpackString (marker, markerHigh, markerLow, buffer) {
    if (markerHigh === TINY_STRING) {
      return utf8.decode(buffer, markerLow)
    } else if (marker === STRING_8) {
      return utf8.decode(buffer, buffer.readUInt8())
    } else if (marker === STRING_16) {
      return utf8.decode(buffer, buffer.readUInt16())
    } else if (marker === STRING_32) {
      return utf8.decode(buffer, buffer.readUInt32())
    } else {
      return null
    }
  }

  _unpackList (marker, markerHigh, markerLow, buffer, hydrateStructure) {
    if (markerHigh === TINY_LIST) {
      return this._unpackListWithSize(markerLow, buffer, hydrateStructure)
    } else if (marker === LIST_8) {
      return this._unpackListWithSize(buffer.readUInt8(), buffer, hydrateStructure)
    } else if (marker === LIST_16) {
      return this._unpackListWithSize(buffer.readUInt16(), buffer, hydrateStructure)
    } else if (marker === LIST_32) {
      return this._unpackListWithSize(buffer.readUInt32(), buffer, hydrateStructure)
    } else {
      return null
    }
  }

  _unpackListWithSize (size, buffer, hydrateStructure) {
    const value = []
    for (let i = 0; i < size; i++) {
      value.push(this.unpack(buffer, hydrateStructure))
    }
    return value
  }

  _unpackByteArray (marker, buffer) {
    if (marker === BYTES_8) {
      return this._unpackByteArrayWithSize(buffer.readUInt8(), buffer)
    } else if (marker === BYTES_16) {
      return this._unpackByteArrayWithSize(buffer.readUInt16(), buffer)
    } else if (marker === BYTES_32) {
      return this._unpackByteArrayWithSize(buffer.readUInt32(), buffer)
    } else {
      return null
    }
  }

  _unpackByteArrayWithSize (size, buffer) {
    const value = new Int8Array(size)
    for (let i = 0; i < size; i++) {
      value[i] = buffer.readInt8()
    }
    return value
  }

  _unpackMap (marker, markerHigh, markerLow, buffer, hydrateStructure) {
    if (markerHigh === TINY_MAP) {
      return this._unpackMapWithSize(markerLow, buffer, hydrateStructure)
    } else if (marker === MAP_8) {
      return this._unpackMapWithSize(buffer.readUInt8(), buffer, hydrateStructure)
    } else if (marker === MAP_16) {
      return this._unpackMapWithSize(buffer.readUInt16(), buffer, hydrateStructure)
    } else if (marker === MAP_32) {
      return this._unpackMapWithSize(buffer.readUInt32(), buffer, hydrateStructure)
    } else {
      return null
    }
  }

  _unpackMapWithSize (size, buffer, hydrateStructure) {
    const value = {}
    for (let i = 0; i < size; i++) {
      const key = this.unpack(buffer, hydrateStructure)
      value[key] = this.unpack(buffer, hydrateStructure)
    }
    return value
  }

  _unpackStruct (marker, markerHigh, markerLow, buffer, hydrateStructure) {
    if (markerHigh === TINY_STRUCT) {
      return this._unpackStructWithSize(markerLow, buffer, hydrateStructure)
    } else if (marker === STRUCT_8) {
      return this._unpackStructWithSize(buffer.readUInt8(), buffer, hydrateStructure)
    } else if (marker === STRUCT_16) {
      return this._unpackStructWithSize(buffer.readUInt16(), buffer, hydrateStructure)
    } else {
      return null
    }
  }

  _unpackStructWithSize (structSize, buffer, hydrateStructure) {
    const signature = buffer.readUInt8()
    const structure = new Structure(signature, [])
    for (let i = 0; i < structSize; i++) {
      structure.fields.push(this.unpack(buffer, hydrateStructure))
    }

    return hydrateStructure(structure)
  }
}

function isIterable (obj) {
  if (obj == null) {
    return false
  }
  return typeof obj[Symbol.iterator] === 'function'
}

export { Packer, Unpacker }
