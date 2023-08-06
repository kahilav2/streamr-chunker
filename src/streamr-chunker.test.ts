import { StreamrChunker } from './streamr-chunker';

describe('StreamrChunker', () => {
  let streamrChunker: StreamrChunker;

  beforeEach(() => {
    streamrChunker = new StreamrChunker();
  });

  afterEach(async () => {
    await streamrChunker.destroy();
  });

  test('should publish a single-chunk message', (done) => {
    const message = { key: 'value' };
    streamrChunker.on('publish', (msg) => {
      expect(msg).toEqual(streamrChunker['wrapChunk'](JSON.stringify(message), msg.b[2], msg.b[3], msg.b[4]));
      done();
    });
    streamrChunker.publish(message);
  });

  test('should publish a chunked message', (done) => {
    const largeMessage = { key: 'a'.repeat(1200000) };

    streamrChunker.on('publish', (msg) => {
      expect(msg.b.length).toEqual(5);
      done();
    });

    streamrChunker.publish(largeMessage);
  });

  test('should unwrap a single-chunk message and emit a message event', (done) => {
    const message = { key: 'value' };
    const deviceId = "testDeviceId";
    const chunkId = 0;
    const lastChunkId = 0;
    const wrappedMessage = streamrChunker['wrapChunk'](JSON.stringify(message), deviceId, chunkId, lastChunkId)

    streamrChunker.on('message', (msg) => {
      expect(msg).toEqual(message);
      done();
    });

    streamrChunker.receiveHandler(wrappedMessage);
  });

  test('should not emit message event for unsupported message when passUnsupportedMessages is not set', () => {
    const unsupportedMessage = 'unsupported';
    const messageSpy = jest.spyOn(streamrChunker, 'emit');
    streamrChunker.receiveHandler(unsupportedMessage);
    expect(messageSpy).not.toHaveBeenCalledWith('message', unsupportedMessage);
  });

  test('should emit message event for unsupported message when passUnsupportedMessages is set', (done) => {
    const unsupportedMessage = 'unsupported';
    streamrChunker.withPassUnsupportedMessages();

    streamrChunker.on('message', (msg) => {
      expect(msg).toEqual(unsupportedMessage);
      done();
    });

    streamrChunker.receiveHandler(unsupportedMessage);
  });

  test('should not emit message event for own message when ignoreOwnMessages is set', () => {
    const message = { key: 'value' };
    const deviceId = 'testDeviceId';
    const wrappedMessage = {
      b: [deviceId, message]
    };
    const messageSpy = jest.spyOn(streamrChunker, 'emit');

    streamrChunker.withIgnoreOwnMessages().withDeviceId(deviceId);
    streamrChunker.receiveHandler(wrappedMessage);

    expect(messageSpy).not.toHaveBeenCalledWith('message', message);
  });

  test('should execute beforeReceiveHook and respect interrupt', () => {
    const message = { key: 'value' };
    const deviceId = "testDeviceId";
    const chunkId = 1;
    const lastChunkId = 2;

    const wrappedMessage = streamrChunker['wrapChunk'](JSON.stringify(message), deviceId, chunkId, lastChunkId);
    const messageSpy = jest.spyOn(streamrChunker, 'emit');
    const hookFn = jest.fn(() => true);

    streamrChunker.withBeforeReceiveHook(hookFn);
    streamrChunker.receiveHandler(wrappedMessage);

    expect(hookFn).toHaveBeenCalledWith(wrappedMessage);
    expect(messageSpy).not.toHaveBeenCalledWith('message', message);
  });
});
