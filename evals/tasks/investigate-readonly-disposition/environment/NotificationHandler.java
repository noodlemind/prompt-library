package example;

/** Fixture: handles two SQS notification types. The cancellation path has a
 * non-atomic check/action defect used to exercise Investigate mode. */
public class NotificationHandler {

  private final OrderStore store;

  public NotificationHandler(OrderStore store) {
    this.store = store;
  }

  public void handle(Notification n) {
    switch (n.type()) {
      case ORDER_PLACED -> handlePlacement(n);
      case ORDER_CANCELLED -> handleCancellation(n);
    }
  }

  private void handlePlacement(Notification n) {
    if (store.wasProcessed(n.orderId())) {
      return; // dedupe: already handled
    }
    store.placeOrder(n.orderId());
    store.markProcessed(n.orderId());
  }

  private void handleCancellation(Notification n) {
    // Non-atomic check-then-act: two concurrent cancellations can both observe
    // wasProcessed == false and each run cancelOrder + markProcessed.
    if (store.wasProcessed(n.orderId())) {
      return;
    }
    store.cancelOrder(n.orderId());
    store.markProcessed(n.orderId());
  }
}
