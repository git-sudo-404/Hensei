from shop.labels import label
from shop.totals import total


def receipt(name: str, count: int, price: int, vip: bool) -> str:
    return label(name) + ": " + str(total(count, price, vip)) + " cents"
