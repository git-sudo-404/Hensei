from shop.base import subtotal


def discount(count: int, price: int, vip: bool) -> int:
    if vip:
        return subtotal(count, price) // 10
    return 0
