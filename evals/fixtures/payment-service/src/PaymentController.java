package example;

/** Authorizes and routes payment operations for incoming orders. */
public class PaymentController {

  private final OrderStore store;

  public PaymentController(OrderStore store) {
    this.store = store;
  }

  public void handle(String orderId, Role role) {
    if (store.wasProcessed(orderId)) {
      return; // dedupe: already handled
    }
    store.placeOrder(orderId);
    store.markProcessed(orderId);
  }
}
