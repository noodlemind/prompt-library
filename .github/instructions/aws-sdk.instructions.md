---
name: 'AWS SDK v2 Conventions'
description: 'AWS SDK for Java v2 patterns, SNS/SQS messaging, and cloud-native best practices'
applyTo: '**/*.java'
---

# AWS SDK v2 Conventions

_For AWS SDK for Java v2 (`software.amazon.awssdk`). Do NOT use v1 (`com.amazonaws`) — it is in maintenance mode._

## Client Setup
- Use the builder pattern: `SqsClient.builder().region(Region.US_EAST_1).build()`.
- Create clients as singletons (one per service per region). Inject via Spring `@Bean` configuration. Never create clients per request.
- Use `DefaultCredentialsProvider` (auto-resolves from env vars → system properties → IAM role → profile). Never hardcode credentials.
- Set `region()` explicitly. Don't rely on `AWS_REGION` env var being set in all environments.
- Close clients in shutdown hooks or use try-with-resources for short-lived scripts.
- Use `SdkHttpClient` configuration for connection pooling: `maxConcurrency`, `connectionTimeout`, `socketTimeout`.

## Async vs Sync
- Prefer async clients (`SqsAsyncClient`, `SnsAsyncClient`) for high-throughput services. They return `CompletableFuture`.
- Use sync clients (`SqsClient`, `SnsClient`) for simple request-response patterns or when the calling code is already synchronous.
- With Spring Boot: async clients work well with `@Async` and `CompletableFuture` return types.
- Always handle `CompletableFuture` exceptions with `.exceptionally()` or `.handle()`. Unhandled exceptions are swallowed silently.

## SQS (Simple Queue Service)
- **Standard queues** for high throughput where at-least-once delivery is acceptable.
- **FIFO queues** when message ordering and exactly-once processing matter. Append `.fifo` to queue name. Set `MessageGroupId` for ordering.
- Use `receiveMessage` with `waitTimeSeconds(20)` for long polling. Never use short polling (0 seconds) — it wastes API calls and money.
- Set `visibilityTimeout` to at least 6x your expected processing time. Prevents duplicate processing.
- Always delete messages after successful processing: `deleteMessage(DeleteMessageRequest)`. Undeleted messages reappear after visibility timeout.
- Use `ChangeMessageVisibility` if processing takes longer than expected. Better than letting the message reappear and duplicate-process.
- Batch operations for throughput: `sendMessageBatch` (up to 10 messages), `deleteMessageBatch`, `receiveMessage` with `maxNumberOfMessages(10)`.
- **Dead-letter queues (DLQ)**: Configure `RedrivePolicy` with `maxReceiveCount`. Route failed messages to a DLQ after N retries. Monitor DLQ depth.
- Message attributes for metadata. Message body for payload. Don't encode metadata in the body.
- For large messages (>256KB): use Amazon SQS Extended Client Library with S3 for payload storage.

## SNS (Simple Notification Service)
- Use topics for fan-out (one message → many subscribers). Use SQS for point-to-point.
- **Standard topics** for high throughput. **FIFO topics** when ordering matters (pair with FIFO SQS queues).
- Use `MessageAttributes` for filter policies. Subscribers filter messages without consuming them.
- Use `publish` with `TopicArn` for topic-based messaging. Use `TargetArn` for direct endpoint delivery.
- For JSON message structure with protocol-specific payloads: set `MessageStructure` to `"json"`.
- Enable raw message delivery on SQS subscriptions to avoid double JSON wrapping.
- Retry and DLQ: SNS retries delivery automatically. Configure DLQ on the subscription for failed deliveries.

## SNS + SQS Integration Pattern
- **Fan-out**: SNS topic → multiple SQS queue subscriptions. Each queue processes independently.
- **Filter**: Use SNS subscription filter policies to route messages to specific queues based on attributes.
- Enable **raw message delivery** on SQS subscriptions to avoid the SNS envelope wrapper.
- Use the same region for SNS topics and SQS queues. Cross-region has latency and cost implications.
- Subscription confirmation is automatic for SQS. For HTTP endpoints, handle the confirmation request.

## Error Handling
- Catch `SdkException` (base class) for all AWS errors. Specific subtypes: `SdkClientException` (client-side), `SdkServiceException` (service-side, includes HTTP status).
- Retry with exponential backoff. The SDK has built-in retry (`RetryPolicy`), but configure it appropriately: `numRetries(3)` for most cases.
- For SQS processing failures: let the message return to the queue (don't delete it). The visibility timeout and DLQ handle retries.
- Check `sdkHttpResponse().statusCode()` when you need the HTTP status for conditional logic.
- Log request IDs from exceptions (`requestId()`) for AWS support troubleshooting.

## Testing
- Use **LocalStack** or **Testcontainers** for integration tests against real AWS service emulations.
- Mock AWS clients with Mockito for unit tests. Mock the client interface, not the implementation.
- Use `@DynamicPropertySource` in Spring Boot tests to inject LocalStack endpoint URLs.
- Test DLQ behavior: send a message that intentionally fails processing N times, verify it arrives in the DLQ.
- Test idempotency: send the same message twice, verify the side effect happens only once.

## Configuration Best Practices
- Store queue URLs and topic ARNs in configuration (`application.yml`), not in code.
- Use different queues/topics per environment (dev, staging, prod). Never share across environments.
- IAM permissions: least privilege. SQS consumer needs `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`. SNS publisher needs `sns:Publish`.
- Enable server-side encryption (SSE) on SQS queues and SNS topics for sensitive data.
- CloudWatch alarms on: `ApproximateNumberOfMessagesVisible` (queue depth), `ApproximateAgeOfOldestMessage` (processing lag), `NumberOfMessagesSent` to DLQ.

## Common Pitfalls
- **Not deleting messages after processing**: Messages reappear and get processed again. Always delete in the success path.
- **Visibility timeout too short**: Message reappears while still being processed, causing duplicate work. Set to 6x processing time minimum.
- **Short polling**: Uses `waitTimeSeconds(0)`, wastes API calls. Always use long polling (`waitTimeSeconds(20)`).
- **Not handling partial batch failures**: If processing 10 messages and 1 fails, you must delete the 9 successes individually. Use `deleteMessageBatch` for the successful ones.
- **Ignoring message ordering in standard queues**: Standard SQS does NOT guarantee order. Use FIFO if order matters.
- **Creating clients per request**: Expensive. Clients are thread-safe singletons. Create once, reuse everywhere.
