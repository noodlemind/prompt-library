package example;

/** Persistence boundary for order processing. */
public interface OrderStore {
  boolean wasProcessed(String orderId);

  void placeOrder(String orderId);

  void cancelOrder(String orderId);

  void markProcessed(String orderId);
}
