# StreamrChunker

StreamrChunker is an abstraction layer between the Streamr Network and your code, allowing you to send objects of any size over the Streamr Network. It handles small messages with minimal overhead, while larger messages are automatically chunked into smaller pieces. Upon receiving the data, the chunks are reassembled for your use.

## Installation

Install StreamrChunker using npm:

```bash
npm install streamr-chunker
``` 

## How to use

Here is an example of how to use StreamrChunker:

```js
import { StreamrChunker } from 'streamr-chunker';
import { StreamrClient } from 'streamr-client';

const streamrChunker = new StreamrChunker()
    .withDeviceId()
    .withIgnoreOwnMessages()

// Send a message of any size over the Streamr Network using StreamrChunker
streamrChunker.publish({ key: 'longMessage'.repeat(10000) });

// Receive a message from StreamrChunker. It comes through in the same format as you sent it.
streamrChunker.on('message', (message) => {
  // ... Handle a received message in your application
  // receives message as you sent it, e.g. { key: 'longMessagelongMessagelongMessage...' }
});

// Pass the messages from StreamrChunker to StreamrClient
streamrChunker.on('publish', (message) => {
  streamrCli.publish(message)
});
```

## Contributing
Contributions are welcome! Please submit a pull request or create an issue for any bug reports or feature requests.