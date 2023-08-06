import { EventEmitter } from 'events';

const ENCRYPTED_MESSAGE_MAX_SIZE_DEFAULT = 1000000;
const DEADLINE_INTERVAL_TIME = 1000;
const TIME_BETWEEN_PUBLISHED_CHUNKS = 250;
const ENCRYPTION_OVERHEAD = 32;
const CHUNK_OVERHEAD = 128;

const generateUniqueId = () => {
  return Math.random().toString(36).substring(2, 8) + Math.random().toString(36).substring(2, 8);
};

enum Index {
  DeviceId = 0,
  Body = 1,
  MessageId = 2,
  ChunkId = 3,
  LastChunkId = 4
}
type ChunkUpdateDatum = { messageId: MessageId; noOfChunks: number; lastChunkId: ChunkId; progress: string };
type ChunkMessage = {
  b: [deviceId: string | null, body: string, messageId: MessageId, chunkId: ChunkId, lastChunkId: ChunkId];
};
type RogueMessage = {
  b: [deviceId: string | null, body: object];
};

type Message = ChunkMessage | RogueMessage;

type ChunkId = number;
type MessageId = string;

/**
 * StreamrChunker is a abstraction layer between Streamr Network and
 * your code that lets you send objects of any size over the
 * Streamr Network. At publish, a small message is wrapped and sent
 * over the network with minimal overhead. A larger message
 * is chunked into smaller messages. At receive, your data is
 * gathered from the chunks.
 *
 * Events triggered by StreamrChunker:
 * 1. 'message': emitted when StreamrChunker has a message ready for you
 * 2. 'publish': emitted when FileStream has a message to be published on the Streamr Network
 * 3. 'chunk-update': emitted when a part of a message (chunk) has been received
 */
class StreamrChunker extends EventEmitter {
  private chunks: Record<string, ChunkMessage[]> = {};
  private deadlines: Record<string, Date> = {};
  private maxMessageSize: number;
  private timeBetweenPublishedChunks: number;
  private intervalId: NodeJS.Timer;
  private passUnsupportedMessages = false;
  private ignoreOwnMessages = false;
  private deviceId: string | null = null;
  private beforeReceiveHook?: (msg: Message) => boolean;

  constructor() {
    super();
    this.maxMessageSize = ENCRYPTED_MESSAGE_MAX_SIZE_DEFAULT;
    this.timeBetweenPublishedChunks = TIME_BETWEEN_PUBLISHED_CHUNKS;
    this.intervalId = setInterval(this.checkDeadlines.bind(this), DEADLINE_INTERVAL_TIME);
  }

  /**
   * checkDeadlines checks and removes expired chunks
   * and their corresponding deadlines.
   */
  private checkDeadlines() {
    const now = new Date();
    const deadlineKeys = Object.keys(this.deadlines);
    for (let i = 0; i < deadlineKeys.length; i++) {
      const key = deadlineKeys[i];
      if (this.deadlines[key] < now) {
        delete this.chunks[key];
        delete this.deadlines[key];
        this.emit('chunk-update', this.getChunkUpdateData());
      }
    }
  }

  /**
   * destroy cleans up the StreamrChunker instance
   */
  public destroy() {
    clearInterval(this.intervalId);
    this.removeAllListeners();
  }

  /**
   * withPassUnsupportedMessages is an option that lets unsupported
   * messages through
   * @returns {StreamrChunker}
   */
  public withPassUnsupportedMessages(): this {
    this.passUnsupportedMessages = true;
    return this;
  }

  /**
   * withBeforeReceiveHook sets a custom hook function that will be executed before
   * processing the received message.
   * @param fn - the hook function to execute before processing the received message
   * @returns {StreamrChunker}
   */
  public withBeforeReceiveHook(fn: (msg: Message) => boolean): this {
    this.beforeReceiveHook = fn;
    return this;
  }

  /**
   * withIgnoreOwnMessages is an option that adds a check
   * at the beginning of message receive that skips processing
   * messages that match the deviceId of the StreamrChunker instance.
   * @returns {StreamrChunker}
   */
  public withIgnoreOwnMessages(): this {
    this.ignoreOwnMessages = true;
    return this;
  }

  /**
   * withDeviceId allows for setting a deviceId or, without a parameter, to
   * generate a globally unique identifier
   * @param id - optional custom deviceId
   * @returns {StreamrChunker}
   */
  public withDeviceId(id?: string): this {
    if (id) {
      this.deviceId = id;
    } else {
      this.deviceId = generateUniqueId();
    }
    return this;
  }

  /**
   * withMaxMessageSize sets the maximum message size that can be sent,
   * which is used as a threshold for chunking. Note that you can set
   * Streamr connection network.webrtcMaxMessageSize when connecting and 
   * that value has to be larger than maxMessageSize.
   * @param maxMessageSize - the maximum message size
   * @returns {StreamrChunker}
   */
  public withMaxMessageSize(maxMessageSize: number): this {
    this.maxMessageSize = maxMessageSize;
    return this;
  }

  /**
   *  withTimeBetweenPublishedChunks sets the time between publishing chunks
   */
  public withTimeBetweenPublishedChunks(timeBetweenPublishedChunks: number): this {
    this.timeBetweenPublishedChunks = timeBetweenPublishedChunks;
    return this;
  }

  /**
   * receiveHandler processes a received message, either emitting it as a single message
   * or collecting and combining chunked messages.
   * @param msg - the received message
   */
  public receiveHandler(msg: unknown) {
    if (!this.isMessage(msg)) {
      if (this.passUnsupportedMessages) {
        this.emit('message', msg);
      }
      return;
    }

    if (this.beforeReceiveHook) {
      const interrupt = this.beforeReceiveHook(msg);
      if (interrupt) return;
    }
    if (this.ignoreOwnMessages && msg.b[Index.DeviceId] === this.deviceId) {
      return;
    }

    if (this.isRogueMessage(msg)) {
      this.emit('message', this.unwrap(msg));
      return;
    }
    this.addChunk(msg);
    const wholeMsg = this.collectChunks(msg.b[Index.MessageId]);
    if (!wholeMsg) {
      this.emit('chunk-update', this.getChunkUpdateData());
      return;
    }
    this.emit('message', wholeMsg);
    delete this.chunks[msg.b[Index.MessageId]];
    delete this.deadlines[msg.b[Index.MessageId]];
    this.emit('chunk-update', this.getChunkUpdateData());
  }

  /**
   * getChunkUpdateData returns an array containing the current progress of each
   * (unfinished) chunked message.
   * @returns {ChunkUpdateDatum[]} the array of chunk update data
   */
  private getChunkUpdateData(): ChunkUpdateDatum[] {
    const chunkUpdateData = [];
    for (const key in this.chunks) {
      const lastChunkId = this.chunks[key][0].b[Index.LastChunkId];
      const noOfChunks = this.chunks[key].length;
      chunkUpdateData.push({
        messageId: key,
        noOfChunks,
        lastChunkId,
        progress: ((100 * noOfChunks) / (lastChunkId + 1)).toFixed(1)
      });
    }
    return chunkUpdateData;
  }

  /**
   * addChunk adds a received chunk message to the chunks record and updates the deadline.
   * @param msg - the received chunk message
   */
  private addChunk(msg: ChunkMessage) {
    if (!this.chunks[msg.b[Index.MessageId]]) {
      this.chunks[msg.b[Index.MessageId]] = [];
    }
    this.chunks[msg.b[Index.MessageId]].push(msg);
    this.deadlines[msg.b[Index.MessageId]] = new Date(new Date().getTime() + 20 * 1000);
  }

  /**
   * collectChunks checks if all chunks for a given messageId have been received.
   * If so, it combines the chunks and returns the complete message object.
   * @param messageId - id of the message to be collected
   * @returns
   */
  private collectChunks(messageId: string): object | undefined {
    const chunks = this.chunks[messageId];
    if (chunks.length === 0) return;

    const lastChunkId = chunks[0].b[4];
    const receivedChunkIds = chunks.map((ch) => ch.b[Index.ChunkId]);
    const required = Array.from({ length: lastChunkId + 1 }, (_, i) => i); // creates a [0, 1, ..., n]
    const everyChunkExists = required.reduce((acc, requiredVal) => {
      return acc && receivedChunkIds.includes(requiredVal);
    }, true);
    if (!everyChunkExists) return;

    let accumulatedBody = '';
    for (let i = 0; i <= lastChunkId; i++) {
      const ithChunk = chunks.find((ch) => ch.b[Index.ChunkId] === i);
      if (ithChunk === undefined) {
        throw new Error('ithChunk was undefined');
      }
      accumulatedBody += this.unwrap(ithChunk);
    }
    try {
      return JSON.parse(accumulatedBody);
    } catch (err: any) {
      throw new Error('StreamrChunker can not parse the pieced together message: ' + err.toString());
    }
  }

  /**
   * createChunks chunks a single large message into smaller messages when the
   * message to be sent would be too large for the Streamr Network.
   * @param msg - message to be chunked
   * @returns {ChunkMessage[]} - array of chunks
   */
  private createChunks(msg: object): ChunkMessage[] {
    const chunks = [];
    const msgStr = JSON.stringify(msg);
    const maxMessageSizePostEncryption = this.maxMessageSize;
    const maxMessageSizePreEncryption = (maxMessageSizePostEncryption - ENCRYPTION_OVERHEAD) / 2;
    const maxBodySize = maxMessageSizePreEncryption - CHUNK_OVERHEAD;
    let idx = 0;
    let body = '';
    const messageId = generateUniqueId();
    let chunkId = 0;
    while (idx < msgStr.length) {
      // in javascript, it's not possible to cut the string at a given byte length
      // so we have to cut it at a given character length and check if the resulting
      // byte length is still within the limit, starting from 1 byte per character.
      for (let byteCount = 1; byteCount <= 4; byteCount++) {
        body = msgStr.substring(idx, idx + maxBodySize / byteCount);
        const bodySize = new TextEncoder().encode(body).length;
        if (bodySize <= maxBodySize) {
          break;
        }
        if (byteCount === 4) {
          throw new Error('could not find a small enough chunk size, which should never happen');
        }
      }

      idx += body.length;
      const chunk = this.wrapChunk(body, messageId, chunkId, -1);
      chunks.push(chunk);

      chunkId++;
    }
    // we only know how many chunks were needed after we have created them
    chunks.forEach((chunk) => (chunk.b[Index.LastChunkId] = chunks.length - 1));

    return chunks;
  }

  /**
   * tryAsRogueMessage wraps the payload and sees if it is small enough
   * to be sent as a single, wholesome message
   * @param json - json object to be wrapped
   * @returns {boolean} whether or not the payload fits into a single message
   */
  private tryAsRogueMessage(json: object): boolean {
    const wrappedJson = this.wrapRogue(json);
    return this.estimateMessageSizeAfterEncryption(wrappedJson) < this.maxMessageSize;
  }

  /**
   * estimateMessageSizeAfterEncryption estimates the size of a message after it has been
   * encrypted. This is a rough estimate, but it is good enough for our purposes.
   * @param json - json of interest
   * @returns {number} size
   */
  private estimateMessageSizeAfterEncryption(content: object | string): number {
    let contentAsString;
    typeof content === 'string' ? (contentAsString = content) : (contentAsString = JSON.stringify(content));
    const sizeInBytes = new TextEncoder().encode(contentAsString).length;
    const sizeAfterEncryption = sizeInBytes * 2 + ENCRYPTION_OVERHEAD;
    return sizeAfterEncryption;
  }

  /**
   * publish signals via a 'publish' event that a message is ready to
   * be published on the Streamr Network.
   * @param json - json object to be published
   * @returns {Promise<void>}
   */
  public async publish(json: object): Promise<void> {
    const ok = this.tryAsRogueMessage(json);
    if (ok) {
      this.emit('publish', this.wrapRogue(json));
      return;
    }

    const chunks = this.createChunks(json);

    for (let i = 0; i < chunks.length; i++) {
      this.emit('publish', chunks[i]);
      if (this.timeBetweenPublishedChunks === 0) continue; // no delay
      
      await new Promise((resolve) => {
        setTimeout(resolve, this.timeBetweenPublishedChunks);
      });
    }
  }

  /**
   * unwrap extracts the original payload from the wrap.
   * @param msg - the message object
   * @returns {object | string} the extracted body
   */
  private unwrap(msg: Message): object | string {
    return msg.b[Index.Body];
  }

  /**
   * wrapRogue wraps payload that is small enough to be sent over
   * the Streamr Network in a single message.
   * @param msg - the message object
   * @returns {RogueMessage} the wrapped message
   */
  private wrapRogue(json: object): RogueMessage {
    return {
      b: [this.deviceId, json]
    };
  }

  /**
   * wrapChunk creates a wrap for a message chunk
   * @param body - the chunk content
   * @param messageId - the unique identifier for the set of chunks
   * @param chunkId - the index of the chunk in the set
   * @param lastChunkId - the index of the last chunk in the set
   * @returns
   */
  private wrapChunk(body: string, messageId: string, chunkId: number, lastChunkId: number): ChunkMessage {
    return {
      b: [this.deviceId, body, messageId, chunkId, lastChunkId]
    };
  }

  /**
   * getChunks returns a shallow copy of all the chunks in the StreamrChunker instance.
   * @returns {Record<string, ChunkMessage[]>} the chunks record
   */
  public getChunks(): Record<string, ChunkMessage[]> {
    return { ...this.chunks };
  }

  /**
   * Narrows the type of an object into Message
   * @param msg - message to be typed
   * @returns
   */
  private isMessage(msg: unknown): msg is Message {
    if (!msg || typeof msg !== 'object' || !('b' in msg)) {
      return false;
    }
    const m = msg as Message;
    return (Array.isArray(m.b) && m.b.length === 2) || m.b.length === 5;
  }

  /**
   * Narrows the type of an object into RogueMessage
   * @param msg - message to be typed
   * @returns
   */
  private isRogueMessage(msg: unknown): msg is RogueMessage {
    return this.isMessage(msg) && msg.b.length === 2;
  }

  /**
   * Narrows the type of an object into ChunkMessage
   * @param msg - message to be typed
   * @returns
   */
  private isChunkMessage(msg: unknown): msg is ChunkMessage {
    return this.isMessage(msg) && msg.b.length === 5;
  }
}

export { StreamrChunker };
