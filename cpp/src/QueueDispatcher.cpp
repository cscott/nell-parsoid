#include "QueueDispatcher.hpp"

namespace parsoid {

    template <class ChunkType>
    void QueueDispatcher<ChunkType>::receive ( ChunkType ret ) {
        queue.push_front( ret.getChunks() );
        if ( ! ret.isAsync() ) {
            haveEndOfInput = true;
        }
        if ( !isActive ) {
            // schedule self with IO service
            io.post(bind(&QueueDispatcher::senderLoop, this));
        }
    }

    template <class ChunkType>
    void QueueDispatcher<ChunkType>::senderLoop() {
        isActive = true;
        // Keep handling items from the queue
        while ( ! queue.empty() ) {
            receiver( queue.back() );
            queue.pop_back();
        }
        isActive = false;
    }
}
