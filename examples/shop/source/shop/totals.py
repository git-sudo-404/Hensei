from shop.base import subtotal
from shop.discounts import discount
from shop.shipping import shipping


def total(count: int, price: int, vip: bool) -> int:
    return subtotal(count, price) - discount(count, price, vip) + shipping(count)
