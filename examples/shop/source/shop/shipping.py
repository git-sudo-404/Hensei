from shop.base import subtotal


def shipping(count: int) -> int:
    if count <= 0:
        return 0
    return subtotal(count, 25) + 100
