import { EventEmitter } from 'events';

const MESSAGE_MAX_SIZE = 256000;
const DEADLINE_INTERVAL_TIME = 1000;
const TIME_BETWEEN_PUBLISHED_CHUNKS = 100;

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
 */
class StreamrChunker extends EventEmitter {
  private chunks: Record<string, ChunkMessage[]> = {};
  private deadlines: Record<string, Date> = {};
  private intervalId: NodeJS.Timer;
  private passUnsupportedMessages = false;
  private ignoreOwnMessages = false;
  private deviceId: string | null = null;
  private beforeReceiveHook?: (msg: Message) => boolean;


  constructor() {
    super();
    this.intervalId = setInterval(this.checkDeadlines.bind(this), DEADLINE_INTERVAL_TIME);
  }


  /**
   * checkDeadlines checks and removes expired chunks
   * and their corresponding deadlines.
   */
  private checkDeadlines() {
    const now = new Date();
    const deadlineKeys = Object.keys(this.deadlines);
    for (let i=0; i<deadlineKeys.length; i++) {
      const key = deadlineKeys[i];
      if (this.deadlines[key] < now) {
        delete this.chunks[key];
        delete this.deadlines[key];
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
   * receiveHandler processes a received message, either emitting it as a single message
   * or collecting and combining chunked messages.
   * @param msg - the received message
   */
  public receiveHandler(msg: unknown) {
    if (!this.isMessage(msg)) {
      if (this.passUnsupportedMessages) {
        this.emit("message", msg);
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
    this.deadlines[msg.b[Index.MessageId]] = new Date((new Date()).getTime() + (20 * 1000))
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
    const maxMessageLen = MESSAGE_MAX_SIZE / 2 - 100; // - 100 to be on the safe side
    const noOfChunksNeeded = Math.ceil(msgStr.length / maxMessageLen);
    const messageId = generateUniqueId();
    const lastChunkId = noOfChunksNeeded - 1;
    for (let i = 0; i < noOfChunksNeeded; i++) {
      const chunkId = i;
      const startingIndex = i * maxMessageLen;
      const endingIndex = (i + 1) * maxMessageLen;
      const body = msgStr.substring(startingIndex, endingIndex);
      const chunk = this.wrapChunk(body, messageId, chunkId, lastChunkId);
      chunks.push(chunk);
    }
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
    return this.calculateJsonSize(wrappedJson) < MESSAGE_MAX_SIZE;
  }


  /**
   * calculateJsonSize calculates the size of the json object
   * @param json - json of interest
   * @returns {number} size
   */
  private calculateJsonSize(json: object): number {
    return JSON.stringify(json).length * 2;
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
      await new Promise((resolve) => {
        setTimeout(resolve, TIME_BETWEEN_PUBLISHED_CHUNKS);
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
