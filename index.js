const COS = require('ibm-cos-sdk')

const BucketFiles = require('./lib/bucket_files.js')
const BucketFileCache = require('./lib/bucket_file_cache.js')
const BucketPoller = require('./lib/bucket_poller.js')
const TimeoutPollingManager = require('./lib/timeout_polling_manager.js')
const Queue = require('./lib/queue.js')
const TriggerQueueListener = require('./lib/trigger_queue_listener.js')
const Validate = require('./lib/validate.js')

// use for self-signed redis certificate
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

module.exports = function (triggerManager, logger, redis = process.env.REDIS) {
  const bucketFileCache = BucketFileCache(redis)
  const scheduler = TimeoutPollingManager()
  const triggers = new Map()

  scheduler.on('error', async (id, err) => {
    logger.error('s3-trigger-feed', `error from s3 polling operation for trigger ${id}`, err)
    triggerManager.disableTrigger(id, null, err.message)
  })

  const add = async (id, details) => {
    // if the trigger is being updated, reset system state for trigger bucket.
    if (triggers.has(id)) {
      remove(id)
    }

    const { bucket, interval, s3_endpoint, s3_apikey } = details

    const client = new COS.S3({ endpoint: s3_endpoint, apiKeyId: s3_apikey })

    const bucketFiles = BucketFiles(client, bucket, logger)
    const bucketEventQueue = Queue(id)
    const fireTrigger = event => triggerManager.fireTrigger(id, event)

    // fires triggers upon file event messages on queue
    const listener = TriggerQueueListener(bucketEventQueue, fireTrigger, logger, id)

    // poll bucket files for changes
    const bucketPoller = BucketPoller(bucketFiles, id, bucketFileCache, bucketEventQueue, logger)

    const interval_in_ms = interval * 60 * 1000

    // schedule bucket polling each minute
    scheduler.add(id, bucketPoller, interval_in_ms)

    triggers.set(id, bucket)
  }
  
  const remove = async id => {
    if (!triggers.has(id)) return

    // stop polling for file changes on bucket
    scheduler.remove(id)

    // remove untriggered file change events
    const queue = Queue(id)
    queue.clear()

    // remove cached file etags 
    await bucketFileCache.del(id)

    triggers.delete(id)
  }

  return { add, remove }
}

module.exports.validate = async params => Validate(params, COS.S3)
