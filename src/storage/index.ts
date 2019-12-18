

import {
  getFullReadUrl,
  connectToGaiaHub, uploadToGaiaHub, getBucketUrl, BLOCKSTACK_GAIA_HUB_LABEL, 
  GaiaHubConfig,
  deleteFromGaiaHub
} from './hub'
// export { type GaiaHubConfig } from './hub'

import {
  encryptECIES, decryptECIES, signECDSA, verifyECDSA, eciesGetJsonByteLength, 
  SignedCipherObject, CipherTextEncoding
} from '../encryption/ec'
import { getPublicKeyFromPrivate, publicKeyToAddress } from '../keys'
import { lookupProfile } from '../profiles/profileLookup'
import {
  InvalidStateError,
  SignatureVerificationError,
  DoesNotExist
} from '../errors'

import { UserSession } from '../auth/userSession'
import { NAME_LOOKUP_PATH } from '../auth/authConstants'
import { getGlobalObject, getBlockstackErrorFromResponse } from '../utils'
import { fetchPrivate } from '../fetchUtil'

/**
 * Specify a valid MIME type, encryption, and whether to sign the [[UserSession.putFile]].
 */
export interface PutFileOptions {
  /**
  * Encrypt the data with the app public key. 
  * If a string is specified, it is used as the public key. 
  * If the boolean `true` is specified then the current user's app public key is used. 
   * @default true
   */
  encrypt?: boolean | string;
  /**
   *
   * If set to `true` the data is signed using ECDSA on SHA256 hashes with the user's
   * app private key. If a string is specified, it is used as the private key instead
   * of the user's app private key. 
   * @default false
   */
  sign?: boolean | string;
  /**
   * Set a Content-Type header for unencrypted data. 
   */
  contentType?: string;
  /**
   * String encoding format for the cipherText buffer.
   * Currently defaults to 'hex' for legacy backwards-compatibility.
   * Only used if the `encrypt` option is also used.
   * Note: in the future this should default to 'base64' for the significant
   * file size reduction.
   */
  cipherTextEncoding?: CipherTextEncoding;
}

export interface EncryptContentOptions {
  publicKey?: string;
  wasString?: boolean;
  /**
   * String encoding format for the cipherText buffer.
   * Currently defaults to 'hex' for legacy backwards-compatibility.
   * Only used if the `encrypt` option is also used.
   * Note: in the future this should default to 'base64' for the significant
   * file size reduction.
   */
  cipherTextEncoding?: CipherTextEncoding;
}

const SIGNATURE_FILE_SUFFIX = '.sig'

/**
 * Fetch the public read URL of a user file for the specified app.
 * @param {String} path - the path to the file to read
 * @param {String} username - The Blockstack ID of the user to look up
 * @param {String} appOrigin - The app origin
 * @param {String} [zoneFileLookupURL=null] - The URL
 * to use for zonefile lookup. If falsey, this will use the
 * blockstack.js's [[getNameInfo]] function instead.
 * @return {Promise<string>} that resolves to the public read URL of the file
 * or rejects with an error
 */
export async function getUserAppFileUrl(
  path: string, username: string, appOrigin: string,
  zoneFileLookupURL?: string
): Promise<string|null> {
  const profile = await lookupProfile(username, zoneFileLookupURL)
  let bucketUrl: string = null
  if (profile.hasOwnProperty('apps')) {
    if (profile.apps.hasOwnProperty(appOrigin)) {
      const url = profile.apps[appOrigin]
      const bucket = url.replace(/\/?(\?|#|$)/, '/$1')
      bucketUrl = `${bucket}${path}`
    }
  }
  return bucketUrl
}

/**
 * 
 * 
 * @deprecated 
 * #### v19 Use [[UserSession.encryptContent]].
 *
 * Encrypts the data provided with the app public key.
 * @param {String|Buffer} content - data to encrypt
 * @param {Object} [options=null] - options object
 * @param {String} options.publicKey - the hex string of the ECDSA public
 * key to use for encryption. If not provided, will use user's appPublicKey.
 * @return {String} Stringified ciphertext object
 */
export async function encryptContent(
  content: string | Buffer,
  options?: EncryptContentOptions,
  caller?: UserSession
): Promise<string> {
  const opts = Object.assign({}, options)
  if (!opts.publicKey) {
    const privateKey = (caller || new UserSession()).loadUserData().appPrivateKey
    opts.publicKey = getPublicKeyFromPrivate(privateKey)
  }
  const isString = typeof content === 'string' || opts.wasString
  const contentBuffer = typeof content === 'string' ? Buffer.from(content) : content
  const cipherObject = await encryptECIES(opts.publicKey, 
                                          contentBuffer, 
                                          isString, 
                                          opts.cipherTextEncoding)
  return JSON.stringify(cipherObject)
}

/**
 * 
 * @deprecated 
 * #### v19 Use [[UserSession.decryptContent]].
 * 
 * Decrypts data encrypted with `encryptContent` with the
 * transit private key.
 * @param {String|Buffer} content - encrypted content.
 * @param {Object} [options=null] - options object
 * @param {String} options.privateKey - the hex string of the ECDSA private
 * key to use for decryption. If not provided, will use user's appPrivateKey.
 * @return {String|Buffer} decrypted content.
 */
export function decryptContent(
  content: string,
  options?: {
    privateKey?: string
  },
  caller?: UserSession
): Promise<string | Buffer> {
  const opts = Object.assign({}, options)
  if (!opts.privateKey) {
    opts.privateKey = (caller || new UserSession()).loadUserData().appPrivateKey
  }

  try {
    const cipherObject = JSON.parse(content)
    return decryptECIES(opts.privateKey, cipherObject)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Failed to parse encrypted content JSON. The content may not '
                      + 'be encrypted. If using getFile, try passing { decrypt: false }.')
    } else {
      throw err
    }
  }
}

/* Get the gaia address used for servicing multiplayer reads for the given
 * (username, app) pair.
 * @private
 * @ignore
 */
async function getGaiaAddress(
  app: string, username?: string, zoneFileLookupURL?: string,
  caller?: UserSession
): Promise<string> {
  const opts = normalizeOptions({ app, username, zoneFileLookupURL }, caller)
  let fileUrl: string
  if (username) {
    fileUrl = await getUserAppFileUrl('/', opts.username, opts.app, opts.zoneFileLookupURL)
  } else {
    if (!caller) {
      caller = new UserSession()
    }
    const gaiaHubConfig = await caller.getOrSetLocalGaiaHubConnection()
    fileUrl = await getFullReadUrl('/', gaiaHubConfig)
  }
  const matches = fileUrl.match(/([13][a-km-zA-HJ-NP-Z0-9]{26,35})/)
  if (!matches) {
    throw new Error('Failed to parse gaia address')
  }
  return matches[matches.length - 1]
}
/**
 * @param {Object} [options=null] - options object
 * @param {String} options.username - the Blockstack ID to lookup for multi-player storage
 * @param {String} options.app - the app to lookup for multi-player storage -
 * defaults to current origin
 * 
 * @ignore
 */
function normalizeOptions<T>(
  options?: {
    app?: string, 
    username?: string,
    zoneFileLookupURL?: string
  } & T,
  caller?: UserSession
) {
  const opts = Object.assign({}, options)
  if (opts.username) {
    if (!opts.app) {
      caller = caller || new UserSession()
      if (!caller.appConfig) {
        throw new InvalidStateError('Missing AppConfig')
      }
      opts.app = caller.appConfig.appDomain
    }
    if (!opts.zoneFileLookupURL) {
      caller = caller || new UserSession()
      if (!caller.appConfig) {
        throw new InvalidStateError('Missing AppConfig')
      }
      if (!caller.store) {
        throw new InvalidStateError('Missing store UserSession')
      }
      const sessionData = caller.store.getSessionData()
      // Use the user specified coreNode if available, otherwise use the app specified coreNode. 
      const configuredCoreNode = sessionData.userData.coreNode || caller.appConfig.coreNode
      if (configuredCoreNode) {
        opts.zoneFileLookupURL = `${configuredCoreNode}${NAME_LOOKUP_PATH}`
      }
    }
  }
  return opts
}

/**
 * @deprecated
 * #### v19 Use [[UserSession.getFileUrl]] instead.
 * 
 * @param {String} path - the path to the file to read
 * @returns {Promise<string>} that resolves to the URL or rejects with an error
 */
export async function getFileUrl(
  path: string, 
  options?: GetFileUrlOptions,
  caller?: UserSession
): Promise<string> {
  const opts = normalizeOptions(options, caller)

  let readUrl: string
  if (opts.username) {
    readUrl = await getUserAppFileUrl(path, opts.username, opts.app, opts.zoneFileLookupURL)
  } else {
    const gaiaHubConfig = await (caller || new UserSession()).getOrSetLocalGaiaHubConnection()
    readUrl = await getFullReadUrl(path, gaiaHubConfig)
  }

  if (!readUrl) {
    throw new Error('Missing readURL')
  } else {
    return readUrl
  }
}

/* Handle fetching the contents from a given path. Handles both
 *  multi-player reads and reads from own storage.
 * @private
 * @ignore
 */
async function getFileContents(path: string, app: string, username: string | undefined, 
                               zoneFileLookupURL: string | undefined,
                               forceText: boolean,
                               caller?: UserSession): Promise<string | ArrayBuffer | null> {
  const opts = { app, username, zoneFileLookupURL }
  const readUrl = await getFileUrl(path, opts, caller)
  const response = await fetchPrivate(readUrl)
  if (!response.ok) {
    throw await getBlockstackErrorFromResponse(response, `getFile ${path} failed.`)
  }
  let contentType = response.headers.get('Content-Type')
  if (typeof contentType === 'string') {
    contentType = contentType.toLowerCase()
  }
  if (forceText || contentType === null
    || contentType.startsWith('text')
    || contentType.startsWith('application/json')) {
    return response.text()
  } else {
    return response.arrayBuffer()
  }
}

/* Handle fetching an unencrypted file, its associated signature
 *  and then validate it. Handles both multi-player reads and reads
 *  from own storage.
 * @private
 * @ignore
 */
async function getFileSignedUnencrypted(path: string, opt: GetFileOptions, caller?: UserSession) {
  // future optimization note:
  //    in the case of _multi-player_ reads, this does a lot of excess
  //    profile lookups to figure out where to read files
  //    do browsers cache all these requests if Content-Cache is set?
  const sigPath = `${path}${SIGNATURE_FILE_SUFFIX}`
  try {
    const [fileContents, signatureContents, gaiaAddress] = await Promise.all([
      getFileContents(path, opt.app, opt.username, opt.zoneFileLookupURL, false, caller),
      getFileContents(sigPath, opt.app, opt.username,
                      opt.zoneFileLookupURL, true, caller),
      getGaiaAddress(opt.app, opt.username, opt.zoneFileLookupURL, caller)
    ])
  
    if (!fileContents) {
      return fileContents
    }
    if (!gaiaAddress) {
      throw new SignatureVerificationError('Failed to get gaia address for verification of: '
                                            + `${path}`)
    }
    if (!signatureContents || typeof signatureContents !== 'string') {
      throw new SignatureVerificationError('Failed to obtain signature for file: '
                                            + `${path} -- looked in ${path}${SIGNATURE_FILE_SUFFIX}`)
    }
    let signature
    let publicKey
    try {
      const sigObject = JSON.parse(signatureContents)
      signature = sigObject.signature
      publicKey = sigObject.publicKey
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error('Failed to parse signature content JSON '
                        + `(path: ${path}${SIGNATURE_FILE_SUFFIX})`
                        + ' The content may be corrupted.')
      } else {
        throw err
      }
    }
    const signerAddress = publicKeyToAddress(publicKey)
    if (gaiaAddress !== signerAddress) {
      throw new SignatureVerificationError(`Signer pubkey address (${signerAddress}) doesn't`
                                            + ` match gaia address (${gaiaAddress})`)
    } else if (!verifyECDSA(fileContents, publicKey, signature)) {
      throw new SignatureVerificationError(
        'Contents do not match ECDSA signature: '
          + `path: ${path}, signature: ${path}${SIGNATURE_FILE_SUFFIX}`
      )
    } else {
      return fileContents
    }
  } catch (err) {
    // For missing .sig files, throw `SignatureVerificationError` instead of `DoesNotExist` error.
    if (err instanceof DoesNotExist && err.message.indexOf(sigPath) >= 0) {
      throw new SignatureVerificationError('Failed to obtain signature for file: '
                                            + `${path} -- looked in ${path}${SIGNATURE_FILE_SUFFIX}`)
    } else {
      throw err
    }
  }
}

/* Handle signature verification and decryption for contents which are
 *  expected to be signed and encrypted. This works for single and
 *  multiplayer reads. In the case of multiplayer reads, it uses the
 *  gaia address for verification of the claimed public key.
 * @private
 * @ignore
 */
async function handleSignedEncryptedContents(caller: UserSession, path: string, 
                                             storedContents: string, app: string, 
                                             privateKey?: string, username?: string, 
                                             zoneFileLookupURL?: string
): Promise<string | Buffer> {
  const appPrivateKey = privateKey || caller.loadUserData().appPrivateKey

  const appPublicKey = getPublicKeyFromPrivate(appPrivateKey)

  let address: string
  if (username) {
    address = await getGaiaAddress(app, username, zoneFileLookupURL, caller)
  } else {
    address = publicKeyToAddress(appPublicKey)
  }
  if (!address) {
    throw new SignatureVerificationError('Failed to get gaia address for verification of: '
                                          + `${path}`)
  }
  let sigObject
  try {
    sigObject = JSON.parse(storedContents)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Failed to parse encrypted, signed content JSON. The content may not '
                      + 'be encrypted. If using getFile, try passing'
                      + ' { verify: false, decrypt: false }.')
    } else {
      throw err
    }
  }
  const signature = sigObject.signature
  const signerPublicKey = sigObject.publicKey
  const cipherText = sigObject.cipherText
  const signerAddress = publicKeyToAddress(signerPublicKey)

  if (!signerPublicKey || !cipherText || !signature) {
    throw new SignatureVerificationError(
      'Failed to get signature verification data from file:'
        + ` ${path}`
    )
  } else if (signerAddress !== address) {
    throw new SignatureVerificationError(`Signer pubkey address (${signerAddress}) doesn't`
                                          + ` match gaia address (${address})`)
  } else if (!verifyECDSA(cipherText, signerPublicKey, signature)) {
    throw new SignatureVerificationError('Contents do not match ECDSA signature in file:'
                                          + ` ${path}`)
  } else if (typeof (privateKey) === 'string') {
    const decryptOpt = { privateKey }
    return caller.decryptContent(cipherText, decryptOpt)
  } else {
    return caller.decryptContent(cipherText)
  }
}

export interface GetFileUrlOptions {
  /**
   * The Blockstack ID to lookup for multi-player storage. 
   * If not specified, the currently signed in username is used.
   */
  username?: string;
  /**
   * The app to lookup for multi-player storage - defaults to current origin. 
   * @default `window.location.origin` 
   * Only if available in the executing environment, otherwise `undefined`.
   */
  app?: string;
  /**
   * The URL to use for zonefile lookup. If falsey, this will use 
   * the blockstack.js's [[getNameInfo]] function instead. 
   */
  zoneFileLookupURL?: string;
}

/**
 * Used to pass options to [[UserSession.getFile]]
 */
export interface GetFileOptions extends GetFileUrlOptions {
  /**
  * Try to decrypt the data with the app private key. 
  * If a string is specified, it is used as the private key. 
   * @default true
   */
  decrypt?: boolean | string;
  /**
   * Whether the content should be verified, only to be used 
   * when [[UserSession.putFile]] was set to `sign = true`.
   * @default false
   */
  verify?: boolean;
}

/**
 * Retrieves the specified file from the app's data store.
 * @param {String} path - the path to the file to read
 * @returns {Promise} that resolves to the raw data in the file
 * or rejects with an error
 */
export async function getFile(
  path: string, 
  options?: GetFileOptions,
  caller?: UserSession
) {
  const defaults: GetFileOptions = {
    decrypt: true,
    verify: false,
    username: null,
    app: getGlobalObject('location', { returnEmptyObject: true }).origin,
    zoneFileLookupURL: null
  }
  const opt = Object.assign({}, defaults, options)

  if (!caller) {
    caller = new UserSession()
  }

  // in the case of signature verification, but no
  //  encryption expected, need to fetch _two_ files.
  if (opt.verify && !opt.decrypt) {
    return getFileSignedUnencrypted(path, opt, caller)
  }

  const storedContents = await getFileContents(path, opt.app, opt.username, 
                                               opt.zoneFileLookupURL, !!opt.decrypt, caller)
  if (storedContents === null) {
    return storedContents
  } else if (opt.decrypt && !opt.verify) {
    if (typeof storedContents !== 'string') {
      throw new Error('Expected to get back a string for the cipherText')
    }
    if (typeof (opt.decrypt) === 'string') {
      const decryptOpt = { privateKey: opt.decrypt }
      return caller.decryptContent(storedContents, decryptOpt)
    } else {
      return caller.decryptContent(storedContents)
    }
  } else if (opt.decrypt && opt.verify) {
    if (typeof storedContents !== 'string') {
      throw new Error('Expected to get back a string for the cipherText')
    }
    let decryptionKey
    if (typeof (opt.decrypt) === 'string') {
      decryptionKey = opt.decrypt
    }
    return handleSignedEncryptedContents(caller, path, storedContents,
                                         opt.app, decryptionKey, opt.username, 
                                         opt.zoneFileLookupURL)
  } else if (!opt.verify && !opt.decrypt) {
    return storedContents
  } else {
    throw new Error('Should be unreachable.')
  }
}

/** @ignore */
type PutFileContent = string | Buffer | ArrayBufferView | ArrayBufferLike | Blob

/** @ignore */
class FileContentLoader {
  readonly content: Buffer | Blob

  readonly wasString: boolean

  readonly contentType: string

  readonly contentByteLength: number

  private loadedData?: Promise<Buffer>

  static readonly supportedTypesMsg = 'Supported types are: `string` (to be UTF8 encoded), '
    + '`Buffer`, `Blob`, `File`, `ArrayBuffer`, `UInt8Array` or any other typed array buffer. '

  constructor(content: PutFileContent, contentType: string) {
    this.wasString = typeof content === 'string'
    this.content = FileContentLoader.normalizeContentDataType(content, contentType)
    this.contentType = contentType || this.detectContentType()
    this.contentByteLength = this.detectContentLength()
  }

  private static normalizeContentDataType(content: PutFileContent, 
                                          contentType: string): Buffer | Blob {
    try {
      if (typeof content === 'string') {
        // If a charset is specified it must be either utf8 or ascii, otherwise the encoded content 
        // length cannot be reliably detected. If no charset specified it will be treated as utf8. 
        const charset = (contentType || '').toLowerCase().replace('-', '')
        if (charset.includes('charset') && !charset.includes('charset=utf8') && !charset.includes('charset=ascii')) {
          throw new Error(`Unable to determine byte length with charset: ${contentType}`)
        }
        if (typeof TextEncoder !== 'undefined') {
          const encodedString = new TextEncoder().encode(content)
          return Buffer.from(encodedString.buffer)
        }
        return Buffer.from(content)
      } else if (Buffer.isBuffer(content)) {
        return content
      } else if (ArrayBuffer.isView(content)) {
        return Buffer.from(content.buffer, content.byteOffset, content.byteLength)
      } else if (typeof Blob !== 'undefined' && content instanceof Blob) {
        return content
      } else if (typeof ArrayBuffer !== 'undefined' && content instanceof ArrayBuffer) {
        return Buffer.from(content)
      } else if (Array.isArray(content)) {
        // Provided with a regular number `Array` -- this is either an (old) method 
        // of representing an octet array, or a dev error. Perform basic check for octet array. 
        if (content.length > 0 
          && (!Number.isInteger(content[0]) || content[0] < 0 || content[0] > 255)) {
          throw new Error(`Unexpected array values provided as file data: value "${content[0]}" at index 0 is not an octet number. ${this.supportedTypesMsg}`)
        }
        return Buffer.from(content)
      } else {
        const typeName = Object.prototype.toString.call(content)
        throw new Error(`Unexpected type provided as file data: ${typeName}. ${this.supportedTypesMsg}`)
      }
    } catch (error) {
      console.error(error)
      throw new Error(`Error processing data: ${error}`)
    }
  }

  private detectContentType(): string {
    if (this.wasString) {
      return 'text/plain; charset=utf-8'
    } else if (typeof Blob !== 'undefined' && this.content instanceof Blob && this.content.type) {
      return this.content.type
    } else {
      return 'application/octet-stream'
    }
  }

  private detectContentLength(): number {
    if (ArrayBuffer.isView(this.content) || Buffer.isBuffer(this.content)) {
      return this.content.byteLength
    } else if (typeof Blob !== 'undefined' && this.content instanceof Blob) {
      return this.content.size
    }
    const typeName = Object.prototype.toString.call(this.content)
    const error = new Error(`Unexpected type "${typeName}" while getting content length`)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(error)
    }
    console.error(error)
    throw error
  }

  private async loadContent(): Promise<Buffer> {
    try {
      if (Buffer.isBuffer(this.content)) {
        return this.content
      } else if (ArrayBuffer.isView(this.content)) {
        return Buffer.from(this.content.buffer)
      } else if (typeof Blob !== 'undefined' && this.content instanceof Blob) {
        const reader = new FileReader()
        const readPromise = new Promise<Buffer>((resolve, reject) => {
          reader.onerror = (err) => {
            reject(err)
          }
          reader.onload = () => {
            const arrayBuffer = reader.result as ArrayBuffer
            resolve(Buffer.from(arrayBuffer))
          }
          reader.readAsArrayBuffer(this.content as Blob)
        })
        const result = await readPromise
        return result
      } else {
        const typeName = Object.prototype.toString.call(this.content)
        throw new Error(`Unexpected type ${typeName}`)
      }
    } catch (error) {
      console.error(error)
      const loadContentError = new Error(`Error loading content: ${error}`)
      console.error(loadContentError)
      throw loadContentError
    }
  }

  load(): Promise<Buffer | string> {
    if (this.loadedData === undefined) {
      this.loadedData = this.loadContent()
    }
    return this.loadedData
  }
}

function megabytesToBytes(megabytes: number) {
  if (!Number.isFinite(megabytes)) {
    return 0
  }
  return Math.floor(megabytes * 1024 * 1024)
}

/**
 * Stores the data provided in the app's data store to to the file specified.
 * @param {String} path - the path to store the data in
 * @param {String|Buffer} content - the data to store in the file
 * @return {Promise} that resolves if the operation succeed and rejects
 * if it failed
 */
export async function putFile(
  path: string,
  content: string | Buffer | ArrayBufferView | Blob,
  options?: PutFileOptions,
  caller?: UserSession,
): Promise<string> {
  const defaults: PutFileOptions = {
    encrypt: true,
    sign: false,
    cipherTextEncoding: 'hex'
  }
  const opt = Object.assign({}, defaults, options)

  if (!caller) {
    caller = new UserSession()
  }

  const gaiaHubConfig = await caller.getOrSetLocalGaiaHubConnection()
  const maxUploadBytes = megabytesToBytes(gaiaHubConfig.max_file_upload_size_megabytes)
  const hasMaxUpload = maxUploadBytes > 0

  const contentLoader = new FileContentLoader(content, opt.contentType)
  let contentType = contentLoader.contentType

  // First, let's figure out if we need to get public/private keys,
  //  or if they were passed in

  let privateKey = ''
  let publicKey = ''
  if (opt.sign) {
    if (typeof (opt.sign) === 'string') {
      privateKey = opt.sign
    } else {
      privateKey = caller.loadUserData().appPrivateKey
    }
  }
  if (opt.encrypt) {
    if (typeof (opt.encrypt) === 'string') {
      publicKey = opt.encrypt
    } else {
      if (!privateKey) {
        privateKey = caller.loadUserData().appPrivateKey
      }
      publicKey = getPublicKeyFromPrivate(privateKey)
    }
  }

  let uploadFn: (hubConfig: GaiaHubConfig) => Promise<string>

  // In the case of signing, but *not* encrypting, we perform two uploads.
  if (!opt.encrypt && opt.sign) {
    if (hasMaxUpload && contentLoader.contentByteLength > maxUploadBytes) {
      // TODO: Use a specific error class type
      throw new Error(`The max file upload size for this hub is ${maxUploadBytes} bytes, the given content is ${contentLoader.contentByteLength} bytes`)
    }
    const contentData = await contentLoader.load()
    const signatureObject = signECDSA(privateKey, contentData)
    const signatureContent = JSON.stringify(signatureObject)

    uploadFn = async (hubConfig: GaiaHubConfig) => {
      const fileUrls = await Promise.all([
        uploadToGaiaHub(path, contentData, hubConfig, contentType),
        uploadToGaiaHub(`${path}${SIGNATURE_FILE_SUFFIX}`,
                        signatureContent, hubConfig, 'application/json')
      ])
      return fileUrls[0]
    }
  } else {
    // In all other cases, we only need one upload.
    let contentForUpload: string | Buffer | Blob
    if (!opt.encrypt && !opt.sign) {
      if (hasMaxUpload && contentLoader.contentByteLength > maxUploadBytes) {
        throw new Error('TODO: size error msg')
      }
      // If content does not need encrypted or signed, it can be passed directly 
      // to the fetch request without loading into memory. 
      contentForUpload = contentLoader.content
    } else {
      const encryptedSize = eciesGetJsonByteLength({
        contentLength: contentLoader.contentByteLength, 
        wasString: contentLoader.wasString,
        useSignedWrapper: !!opt.sign,
        cipherTextEncoding: opt.cipherTextEncoding
      })
      if (hasMaxUpload && encryptedSize > maxUploadBytes) {
        // TODO: Use a specific error class type
        throw new Error(`The max file upload size for this hub is ${maxUploadBytes} bytes, the given content is ${encryptedSize} bytes`)
      }
      if (!opt.sign) {
        const contentData = await contentLoader.load()
        contentForUpload = await encryptContent(contentData, { 
          publicKey, 
          wasString: contentLoader.wasString,
          cipherTextEncoding: opt.cipherTextEncoding
        })
        contentType = 'application/json'
      } else {
        const contentData = await contentLoader.load()
        const cipherText = await encryptContent(contentData, { 
          publicKey, 
          wasString: contentLoader.wasString,
          cipherTextEncoding: opt.cipherTextEncoding
        })
        const signatureObject = signECDSA(privateKey, cipherText)
        const signedCipherObject: SignedCipherObject = {
          signature: signatureObject.signature,
          publicKey: signatureObject.publicKey,
          cipherText
        }
        contentForUpload = JSON.stringify(signedCipherObject)
        contentType = 'application/json'
      }
    }

    uploadFn = async (hubConfig: GaiaHubConfig) => {
      const file = await uploadToGaiaHub(path, contentForUpload, hubConfig, contentType)
      return file
    }
  }

  try {
    return await uploadFn(gaiaHubConfig)
  } catch (error) {
    const freshHubConfig = await caller.setLocalGaiaHubConnection()
    return await uploadFn(freshHubConfig)
  }
}

/**
 * Deletes the specified file from the app's data store. 
 * @param path - The path to the file to delete.
 * @param options - Optional options object.
 * @param options.wasSigned - Set to true if the file was originally signed
 * in order for the corresponding signature file to also be deleted.
 * @returns Resolves when the file has been removed or rejects with an error.
 */
export async function deleteFile(
  path: string, 
  options?: {
    wasSigned?: boolean;
  },
  caller?: UserSession
) {
  if (!caller) {
    caller = new UserSession()
  }
  const gaiaHubConfig = await caller.getOrSetLocalGaiaHubConnection()
  const opts = Object.assign({}, options)
  if (opts.wasSigned) {
    // If signed, delete both the content file and the .sig file
    try {
      await deleteFromGaiaHub(path, gaiaHubConfig)
      await deleteFromGaiaHub(`${path}${SIGNATURE_FILE_SUFFIX}`, gaiaHubConfig)
    } catch (error) {
      const freshHubConfig = await caller.setLocalGaiaHubConnection()
      await deleteFromGaiaHub(path, freshHubConfig)
      await deleteFromGaiaHub(`${path}${SIGNATURE_FILE_SUFFIX}`, gaiaHubConfig)
    }
  } else {
    try {
      await deleteFromGaiaHub(path, gaiaHubConfig)
    } catch (error) {
      const freshHubConfig = await caller.setLocalGaiaHubConnection()
      await deleteFromGaiaHub(path, freshHubConfig)
    }
  }
}

/**
 * Get the app storage bucket URL
 * @param {String} gaiaHubUrl - the gaia hub URL
 * @param {String} appPrivateKey - the app private key used to generate the app address
 * @returns {Promise} That resolves to the URL of the app index file
 * or rejects if it fails
 */
export function getAppBucketUrl(gaiaHubUrl: string, appPrivateKey: string) {
  return getBucketUrl(gaiaHubUrl, appPrivateKey)
}

/**
 * Loop over the list of files in a Gaia hub, and run a callback on each entry.
 * Not meant to be called by external clients.
 * @param {GaiaHubConfig} hubConfig - the Gaia hub config
 * @param {String | null} page - the page ID
 * @param {number} callCount - the loop count
 * @param {number} fileCount - the number of files listed so far
 * @param {function} callback - the callback to invoke on each file.  If it returns a falsey
 *  value, then the loop stops.  If it returns a truthy value, the loop continues.
 * @returns {Promise} that resolves to the number of files listed.
 * @private
 * @ignore
 */
async function listFilesLoop(
  caller: UserSession,
  hubConfig: GaiaHubConfig | null,
  page: string | null,
  callCount: number,
  fileCount: number,
  callback: (name: string) => boolean
): Promise<number> {
  if (callCount > 65536) {
    // this is ridiculously huge, and probably indicates
    // a faulty Gaia hub anyway (e.g. on that serves endless data)
    throw new Error('Too many entries to list')
  }

  hubConfig = hubConfig || await caller.getOrSetLocalGaiaHubConnection()
  let response: Response
  try {
    const pageRequest = JSON.stringify({ page })
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': `${pageRequest.length}`,
        Authorization: `bearer ${hubConfig.token}`
      },
      body: pageRequest
    }
    response = await fetchPrivate(`${hubConfig.server}/list-files/${hubConfig.address}`, fetchOptions)
    if (!response.ok) {
      throw await getBlockstackErrorFromResponse(response, 'ListFiles failed.')
    }
  } catch (error) {
    // If error occurs on the first call, perform a gaia re-connection and retry.
    // Same logic as other gaia requests (putFile, getFile, etc).
    if (callCount === 0) {
      const freshHubConfig = await caller.setLocalGaiaHubConnection()
      return listFilesLoop(caller, freshHubConfig, page, callCount + 1, 0, callback)
    }
    throw error
  }

  const responseText = await response.text()
  const responseJSON = JSON.parse(responseText)
  const entries = responseJSON.entries
  const nextPage = responseJSON.page
  if (entries === null || entries === undefined) {
    // indicates a misbehaving Gaia hub or a misbehaving driver
    // (i.e. the data is malformed)
    throw new Error('Bad listFiles response: no entries')
  }
  let entriesLength = 0
  for (let i = 0; i < entries.length; i++) {
    // An entry array can have null entries, signifying a filtered entry and that there may be
    // additional pages
    if (entries[i] !== null) {
      entriesLength++
      const rc = callback(entries[i])
      if (!rc) {
        // callback indicates that we're done
        return fileCount + i
      }
    }
  }
  if (nextPage && entries.length > 0) {
    // keep going -- have more entries
    return listFilesLoop(
      caller, hubConfig, nextPage, callCount + 1, fileCount + entriesLength, callback
    )
  } else {
    // no more entries -- end of data
    return fileCount + entriesLength
  }
}

/**
 * List the set of files in this application's Gaia storage bucket.
 * @param {function} callback - a callback to invoke on each named file that
 * returns `true` to continue the listing operation or `false` to end it
 * @return {Promise} that resolves to the total number of listed files. 
 * If the call is ended early by the callback, the last file is excluded. 
 * If an error occurs the entire call is rejected.
 */
export function listFiles(
  callback: (name: string) => boolean,
  caller?: UserSession
): Promise<number> {
  caller = caller || new UserSession()
  return listFilesLoop(caller, null, null, 0, 0, callback)
}

export { connectToGaiaHub, uploadToGaiaHub, BLOCKSTACK_GAIA_HUB_LABEL }
